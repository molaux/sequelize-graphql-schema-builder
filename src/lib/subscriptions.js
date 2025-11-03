import { GraphQLList } from 'graphql'
import { withFilter } from 'graphql-subscriptions'
import { GraphQLJSON } from 'graphql-type-json'

const AccumulatorPubSub = function () {
  this.register = []
  return {
    publish: (event, payload) => {
      this.register.push({ event, payload })
    },
    flushTo: (pubSub, ctx) => {
      const payloads = {}
      for (const { event, payload } of this.register) {
        payload.emitterContext = ctx
        if (!payloads[event]) {
          payloads[event] = []
        }
        payloads[event].push(payload)
      }
      for (const event in payloads) {
        pubSub.publish(event, payloads[event])
      }
    }
  }
}

const payloadsReducer = (model, payloads, context, contextFilter, args) => Array.from(payloads
  // filter payloads by model
  .filter(({ model: { name: payloadModelName }, emitterContext }) => payloadModelName === model.name &&
    (!contextFilter || contextFilter(emitterContext, context, args, model, payloads)))
  // resolve instances
  .map(({ ids, instances }) => ([
    ...ids ?? [],
    ...instances ? instances.map((instance) => instance[model.primaryKeyAttribute]) : []
  ]))
  // unicity
  .reduce((set, ids) => ids.reduce((set, id) => set.add(id), set), new Set())
  .values())

const instancesResolverFactory = (model, manyResolver, contextFilter) => (payloads, args, context, ...rest) => {
  if (payloads.length) {
    return manyResolver(
      null,
      {
        query: {
          where: {
            _andOp: [
              {
                [model.primaryKeyAttribute]: {
                  _inOp: payloadsReducer(model, payloads, context, contextFilter, args)
                }
              },
              ...args?.query?.where ? [args.query.where] : []
            ]
          }
        }
      },
      context,
      ...rest)
  } else {
    return []
  }
}

const subscribeToModelInstancesFactory = (model, action, contextFilter) => (payload, args, { pubSub, ...ctx }, ...rest) => withFilter(
  () => pubSub.asyncIterableIterator(action),
  (payloads) => payloads.reduce(
    (keep, { model: { name: payloadModelName }, emitterContext }) => (keep || payloadModelName === model.name) &&
      (!contextFilter || contextFilter(emitterContext, { pubSub, ...ctx }, args, model, payload)),
    false
  )
)(payload, args, { pubSub, ...ctx }, ...rest)

export {
  AccumulatorPubSub,
  payloadsReducer,
  instancesResolverFactory,
  subscribeToModelInstancesFactory
}
export const builder = (model, modelType, modelIDType, manyResolver, { nameFormatter, contextFilter }) => {
  const createdModelSubscriptionName = nameFormatter.formatCreatedSubscriptionName(model.name)
  const updatedModelSubscriptionName = nameFormatter.formatUpdatedSubscriptionName(model.name)
  const deletedModelSubscriptionName = nameFormatter.formatDeletedSubscriptionName(model.name)

  return {
    [createdModelSubscriptionName]: {
      namespace: nameFormatter.formatModelName(model.name),
      args: {
        query: { type: GraphQLJSON },
        config: { type: GraphQLJSON }
      },
      type: new GraphQLList(modelType),
      subscribe: subscribeToModelInstancesFactory(model, 'modelsCreated', contextFilter),
      resolve: instancesResolverFactory(model, manyResolver, contextFilter)
    },

    [updatedModelSubscriptionName]: {
      namespace: nameFormatter.formatModelName(model.name),
      args: {
        query: { type: GraphQLJSON },
        config: { type: GraphQLJSON }
      },
      type: new GraphQLList(modelType),
      subscribe: subscribeToModelInstancesFactory(model, 'modelsUpdated', contextFilter),
      resolve: instancesResolverFactory(model, manyResolver, contextFilter)
    },

    [deletedModelSubscriptionName]: {
      namespace: nameFormatter.formatModelName(model.name),
      args: {
        config: { type: GraphQLJSON }
      },
      type: new GraphQLList(modelIDType),
      subscribe: subscribeToModelInstancesFactory(model, 'modelsDeleted', contextFilter),
      resolve: (payloads, args, context) => payloadsReducer(model, payloads, context, contextFilter, args).map((id) => ({ [model.primaryKeyAttribute]: id }))
    }
  }
}
