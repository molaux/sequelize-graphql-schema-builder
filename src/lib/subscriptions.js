const { GraphQLList } = require('graphql')
const { withFilter } = require('graphql-subscriptions')

const AccumulatorPubSub = function () {
  this.register = []
  return {
    publish: (event, payload) => {
      this.register.push({ event, payload })
    },
    flushTo: (pubSub) => {
      const payloads = {}
      for (const { event, payload } of this.register) {
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

const payloadsReducer = (model, payloads) => Array.from(payloads
  // filter payloads by model
  .filter(({ model: { name: payloadModelName } }) => payloadModelName === model.name)
  // resolve instances
  .map(({ ids, instances }) => ([
    ...ids ?? [],
    ...instances ? instances.map((instance) => instance[model.primaryKeyAttribute]) : []
  ]))
  // unicity
  .reduce((set, ids) => ids.reduce((set, id) => set.add(id), set), new Set())
  .values())

const instancesResolverFactory = (model, manyResolver) => (payloads, args, ...rest) => {
  if (payloads.length) {
    return manyResolver(
      null,
      {
        query: {
          where: {
            [model.primaryKeyAttribute]: {
              _inOp: payloadsReducer(model, payloads)
            }
          }
        }
      },
      ...rest)
  } else {
    return []
  }
}

const subscribeToModelInstancesFactory = (model, action) => (payload, args, { pubSub, ...ctx }, ...rest) => withFilter(
  () => pubSub.asyncIterator(action),
  (payloads) => payloads.reduce(
    (keep, { model: { name: payloadModelName } }) => keep || payloadModelName === model.name,
    false
  )
)(payload, args, { pubSub, ...ctx }, ...rest)

module.exports = {
  AccumulatorPubSub,
  payloadsReducer,
  instancesResolverFactory,
  subscribeToModelInstancesFactory,
  builder: (model, modelType, modelIDType, manyResolver, { nameFormatter }) => {
    const createdModelSubscriptionName = nameFormatter.formatCreatedSubscriptionName(model.name)
    const updatedModelSubscriptionName = nameFormatter.formatUpdatedSubscriptionName(model.name)
    const deletedModelSubscriptionName = nameFormatter.formatDeletedSubscriptionName(model.name)

    return {
      [createdModelSubscriptionName]: {
        type: new GraphQLList(modelType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsCreated'),
        resolve: instancesResolverFactory(model, manyResolver)
      },

      [updatedModelSubscriptionName]: {
        type: new GraphQLList(modelType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsUpdated'),
        resolve: instancesResolverFactory(model, manyResolver)
      },

      [deletedModelSubscriptionName]: {
        type: new GraphQLList(modelIDType),
        subscribe: subscribeToModelInstancesFactory(model, 'modelsDeleted'),
        resolve: (payloads) => payloadsReducer(model, payloads).map((id) => ({ [model.primaryKeyAttribute]: id }))
      }
    }
  }
}
