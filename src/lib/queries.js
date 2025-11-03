import {
  GraphQLList, GraphQLInt
} from 'graphql'

import { GraphQLJSON } from 'graphql-type-json'

import {
  beforeResolverFactory
} from './resolvers.js'

import {
  getRequestedAttributes
} from './graphql.js'

import graphQLSequelizePkg from 'graphql-sequelize'
const { resolver } = graphQLSequelizePkg

export const manyResolverFactory = (model, { nameFormatter, logger, maxManyAssociations }) => async (parent, args, ...rest) =>
  await resolver(model, {
    before: async ({ attributes, ...otherFindOptions }, args, ctx, infos, ...rest) => {
      const findOptions = await beforeResolverFactory(model, { nameFormatter, logger, maxManyAssociations })({
        ...otherFindOptions,
        attributes: getRequestedAttributes(model, infos.fieldNodes[0], infos, logger)
      }, args, ctx, infos, ...rest)
      return findOptions
    }
    // after: async (result, args, ctx, infos, ...rest) => {
    //   console.log(({ result, args, ctx, infos, ...rest }))
    //   return result
    // }
  })(parent, args, ...rest)

export const countResolverFactory = (model, { nameFormatter, logger, maxManyAssociations }) => async (parent, args, ctx, infos, ...rest) => {
  const result = (await model.count({
    ...(await beforeResolverFactory(model, { nameFormatter, logger, maxManyAssociations })({}, args, ctx, infos, ...rest)),
    order: undefined,
    offset: undefined,
    limit: undefined,
    attributes: undefined
  }))
  return result
}

export const builder = (model, modelType, modelMetaType, manyResolver, countResolver, { nameFormatter }) => {
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
