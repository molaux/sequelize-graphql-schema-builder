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
  builder: (model, modelType, modelValidatorType, manyResolver, { nameFormatter }) => {
    const manyQueryName = nameFormatter.formatManyQueryName(model.name)
    return {
      [manyQueryName]: {
        // The resolver will use `findOne` or `findAll` depending on whether the field it's used in is a `GraphQLList` or not.
        type: new GraphQLList(modelType),
        args: {
          query: { type: GraphQLJSON }
        },
        resolve: manyResolver
      },
      [nameFormatter.formatModelValidatorQueryName(model.name)]: {
        type: modelValidatorType,
        resolve: () => {
          return Object.keys(model.rawAttributes).reduce((o, attribute) => ({
            ...o,
            [attribute]: model.rawAttributes[attribute].validator || null
          }), {})
        }
      }
    }
  }
}
