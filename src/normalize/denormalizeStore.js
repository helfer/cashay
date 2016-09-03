import {TypeKind} from 'graphql/type/introspection';
import {INLINE_FRAGMENT} from 'graphql/language/kinds';
import {
  defaultResolveFactory,
  ensureRootType,
  ensureTypeFromNonNull,
  getFieldSchema,
  isLive,
  makeFullChannel,
  TYPENAME
} from '../utils';
import {
  calculateSendToServer,
  sendChildrenToServer,
  handleMissingData,
  getDocFromNormalString
} from './denormalizeHelpers';
import getFieldState from './getFieldState';

const {UNION, LIST, OBJECT} = TypeKind;

const arrayMetadata = ['BOF', 'EOF', 'count'];

const visitObject = (subState = {}, reqAST, subSchema, context, baseReduction = {}) => {
  return reqAST.selectionSet.selections.reduce((reduction, field) => {
    if (field.kind === INLINE_FRAGMENT) {
      // TODO handle null typeCondition?
      if (field.typeCondition.name.value === subSchema.name) {
        // only follow through if it's the correct union subtype
        visitObject(subState, field, subSchema, context, reduction);
      }
    } else if (field.name.value === TYPENAME) {
      reduction[TYPENAME] = subSchema.name;
    } else {
      const fieldName = field.name.value;
      const aliasOrFieldName = field.alias && field.alias.value || fieldName;

      const fieldSchema = getFieldSchema(field, subSchema, context.schema);
      if (field.directives.length) {
        debugger
      }
      const hasData = subState.hasOwnProperty(fieldName);

      if (hasData) {
        let fieldState = subState[fieldName];
        if (fieldSchema.args) {
          fieldState = getFieldState(fieldState, fieldSchema, field, context);
        }
        reduction[aliasOrFieldName] = visit(fieldState, field, fieldSchema, context);
        if (field.selectionSet) {
          calculateSendToServer(field, context.idFieldName)
        }
      } else {
        reduction[aliasOrFieldName] = handleMissingData(visit, aliasOrFieldName, field, fieldSchema, context);
      }
    }
    return reduction
  }, baseReduction);
};

const visitNormalizedString = (subState, reqAST, subSchema, context) => {
  const {typeName, docId} = getDocFromNormalString(subState);
  const doc = context.getState().entities[typeName][docId];
  const fieldSchema = context.schema.types[typeName];
  return visit(doc, reqAST, fieldSchema, context);
};

const visitIterable = (subState, reqAST, subSchema, context) => {

  // recurse into the root type, since it could be nonnull(list(nonnull(rootType))). Doesn't work with list of lists
  const fieldType = ensureRootType(subSchema.type);

  if (Array.isArray(subState)) {
    // get the schema for the root type, could be a union
    const fieldSchema = context.schema.types[fieldType.name];

    // for each value in the array, get the denormalized item
    const mappedState = [];
    for (let i = 0; i < subState.length; i++) {
      const res = subState[i];
      mappedState[i] = visit(res, reqAST, fieldSchema, context);
    }
    for (let i = 0; i < arrayMetadata.length; i++) {
      const metadataName = arrayMetadata[i];
      if (subState[metadataName]) {
        mappedState[metadataName] = subState[metadataName];
      }
    }
    return mappedState;
  }
  // recursively climb down the tree, flagging each branch with sendToServer
  sendChildrenToServer(reqAST);

  // return an empty array as a placeholder for the data that will come from the server
  return [];
};

const visitScalar = (subState, scalarType, coerceTypes) => {
  const coercion = coerceTypes[scalarType];
  return coercion ? coercion(subState) : subState;
};

const visit = (subState, reqAST, subSchema, context) => {
  // By implementing a ternary here, we can get rid of a pointless O(n) find in visitObject
  const objectType = subSchema.kind ? subSchema.kind : subSchema.type.kind;
  switch (objectType) {
    case OBJECT:
      if (typeof subState === 'string') {
        return visitNormalizedString(subState, reqAST, subSchema, context);
      }
      return visitObject(subState, reqAST, subSchema, context);
    case UNION:
      return visitNormalizedString(subState, reqAST, subSchema, context);
    case LIST:
      return visitIterable(subState, reqAST, subSchema, context);
    default:
      const name = subSchema.name ? subSchema.name : subSchema.type.name;
      return visitScalar(subState, name, context.coerceTypes);
  }
};

export default function denormalizeStore(context, defaultSchema = 'querySchema') {
  // Lookup the root schema for the operationType (hardcoded name in the return of the introspection query)

  // a query operation can have multiple queries, gotta catch 'em all
  const {schema} = context;
  const queryReduction = context.operation.selectionSet.selections.reduce((reduction, selection) => {
    const queryName = selection.name.value;
    // aliases are common for executing the same query twice (eg getPerson(id:1) getPerson(id:2))
    const aliasOrName = selection.alias && selection.alias.value || queryName;
    // get the query schema to know the expected type and args
    const queryFieldSchema = getFieldSchema(selection, schema[defaultSchema], schema);
    // look into the current redux state to see if we can borrow any data from it
    const queryInState = context.getState().result[queryName];
    let fieldState;
    if (isLive(selection.directives)) {
      const returnType = ensureTypeFromNonNull(queryFieldSchema.type);
      const {live = {}, idFieldName, getState, queryDep, subscribe, subscriptionDeps, variables} = context;
      const {resolve, subscriber} = live[aliasOrName] || {};
      const bestSubscriber = subscriber || context.subscriber;
      const resolveChannelKey = resolve || defaultResolveFactory(idFieldName);
      const channelKey = resolveChannelKey(null, variables);
      const initialState = subscribe(aliasOrName, channelKey, bestSubscriber, {returnType});
      const results = getState().result;
      //
      fieldState = results[aliasOrName] && results[aliasOrName][channelKey] || initialState;
      const subDep = makeFullChannel(aliasOrName, channelKey);
      subscriptionDeps[subDep] = subscriptionDeps[subDep] || new Set();
      subscriptionDeps[subDep].add(queryDep);
    } else {
      // if there's no results stored or being fetched, save some time & don't bother with the args
      fieldState = getFieldState(queryInState, queryFieldSchema, selection, context);
    }

    // get the expected return value, devs can be silly, so if the had the return value in a nonnull, remove it.
    const nonNullQueryFieldSchemaType = ensureTypeFromNonNull(queryFieldSchema.type);
    const subSchema = nonNullQueryFieldSchemaType.kind === LIST ? queryFieldSchema :
      ensureTypeFromNonNull(context.schema.types[nonNullQueryFieldSchemaType.name]);

    // recursively visit each branch, flag missing branches with a sendToServer flag
    reduction[aliasOrName] = visit(fieldState, selection, subSchema, context);

    // ugly code that's necessary in case the selection is a scalar. TODO clean!
    if (selection.selectionSet) {
      //shallowly climb the tree checking for the sendToServer flag. if it's present on a child, add it to the parent.
      calculateSendToServer(selection, context.idFieldName);
    } else if (reduction[aliasOrName] === undefined) {
      selection.sendToServer = true;
    }
    return reduction
  }, {});

  // add a sendToServerFlag to the operation if any of the queries need data from the server
  calculateSendToServer(context.operation, context.idFieldName);

  // return what the user expects GraphQL to return

  return queryReduction
};
