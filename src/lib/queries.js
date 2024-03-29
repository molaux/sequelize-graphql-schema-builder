const { resolver } = require('graphql-sequelize')
const {
  GraphQLList
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
      return findOptions
    }
  })(parent, args, ...rest)

module.exports = {
  manyResolverFactory,
  builder: (model, modelType, modelMetaType, manyResolver, { nameFormatter }) => {
    const manyQueryName = nameFormatter.formatManyQueryName(model.name)
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
