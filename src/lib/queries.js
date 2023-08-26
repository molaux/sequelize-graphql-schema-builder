const { resolver } = require('graphql-sequelize')
const Sequelize = require('sequelize')

const {
  GraphQLList, GraphQLInt
} = require('graphql')
const { GraphQLJSON } = require('graphql-type-json')

const {
  beforeResolverFactory
} = require('./resolvers.js')

const {
  getRequestedAttributes
} = require('./graphql.js')

const manyResolverFactory = (model, { nameFormatter, logger, maxManyAssociations }) => async (parent, args, ...rest) =>
  await resolver(model, {
    before: async ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => {
      const findOptions = await beforeResolverFactory(model, { nameFormatter, logger, maxManyAssociations })({
        ...otherFindOptions,
        attributes: getRequestedAttributes(model, infos.fieldNodes[0], infos, logger)
      }, args, ctx, infos, ...rest)
      console.dir(findOptions, { depth: 3 })
      return findOptions
    }
  })(parent, args, ...rest)

const countResolverFactory = (model, { nameFormatter, logger, maxManyAssociations }) => async (parent, args, ctx, infos, ...rest) => {
  const result = (await model.findOne({
    ...(await beforeResolverFactory(model, { nameFormatter, logger, maxManyAssociations })({
      attributes: []
    }, args, ctx, infos, ...rest)),
    attributes: [[Sequelize.fn('COUNT', Sequelize.col('*')), '__count__']],
    include: []
  }))
  return result.dataValues.__count__
}

module.exports = {
  manyResolverFactory,
  countResolverFactory,
  builder: (model, modelType, modelMetaType, manyResolver, countResolver, { nameFormatter }) => {
    const manyQueryName = nameFormatter.formatManyQueryName(model.name)
    const countQueryName = nameFormatter.formatCountQueryName(model.name)
    const metaFields = modelMetaType._fields()
    const defaultValuesFields = metaFields?.defaultValues?.type._fields()
    return {
      [manyQueryName]: {
        namespace: nameFormatter.formatModelName(model.name),
        // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
        type: new GraphQLList(modelType),
        args: {
          query: { type: GraphQLJSON }
        },
        resolve: manyResolver
      },
      [countQueryName]: {
        namespace: nameFormatter.formatModelName(model.name),
        // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
        type: GraphQLInt,
        args: {
          query: { type: GraphQLJSON }
        },
        resolve: countResolver
      },
      [nameFormatter.formatModelMetaQueryName(model.name)]: {
        namespace: nameFormatter.formatModelName(model.name),
        type: modelMetaType,
        resolve: () => ({
          validators: Object.keys(model.rawAttributes).reduce((o, attribute) => ({
            ...o,
            [attribute]: model.rawAttributes[attribute].validator || null
          }), {}),
          ...defaultValuesFields
            ? {
                defaultValues: Object.keys(defaultValuesFields).reduce((o, attribute) => ({
                  ...o,
                  [attribute]: model.rawAttributes[attribute].defaultValue
                }), {})
              }
            : null
        })
      }
    }
  }
}
