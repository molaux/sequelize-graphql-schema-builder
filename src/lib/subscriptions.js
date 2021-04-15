const { GraphQLList } = require('graphql')
const { withFilter } = require('graphql-subscriptions')

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

const payloadsReducer = (model, payloads, context, contextFilter) => Array.from(payloads
  // filter payloads by model
  .filter(({ model: { name: payloadModelName }, emitterContext }) => payloadModelName === model.name &&
    (!contextFilter || contextFilter(emitterContext, context)))
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
            [model.primaryKeyAttribute]: {
              _inOp: payloadsReducer(model, payloads, context, contextFilter)
            }
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
  () => pubSub.asyncIterator(action),
  (payloads) => payloads.reduce(
    (keep, { model: { name: payloadModelName }, emitterContext }) => (keep || payloadModelName === model.name) &&
      (!contextFilter || contextFilter(emitterContext, ctx)),
    false
  )
)(payload, args, { pubSub, ...ctx }, ...rest)

module.exports = {
  AccumulatorPubSub,
  payloadsReducer,
  instancesResolverFactory,
  subscribeToModelInstancesFactory,
  builder: (model, modelType, modelIDType, manyResolver, { nameFormatter, contextFilter }) => {
    const createdModelSubscriptionName = nameFormatter.formatCreatedSubscriptionName(model.name)
    const updatedModelSubscriptionName = nameFormatter.formatUpdatedSubscriptionName(model.name)
    const deletedModelSubscriptionName = nameFormatter.formatDeletedSubscriptionName(model.name)

    return {
      [createdModelSubscriptionName]: {
        type: new GraphQLList(modelType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsCreated', contextFilter),
        resolve: instancesResolverFactory(model, manyResolver, contextFilter)
      },

      [updatedModelSubscriptionName]: {
        type: new GraphQLList(modelType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsUpdated', contextFilter),
        resolve: instancesResolverFactory(model, manyResolver, contextFilter)
      },

      [deletedModelSubscriptionName]: {
        type: new GraphQLList(modelIDType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsDeleted', contextFilter),
        resolve: (payloads, args, context) => payloadsReducer(model, payloads, context, contextFilter).map((id) => ({ [model.primaryKeyAttribute]: id }))
      }
    }
  }
}
