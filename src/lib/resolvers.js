'use strict'
const Sequelize = require('sequelize')
const { getRequestedAttributes } = require('./graphql')
const { getNestedElements } = require('./sequelize')
const { cleanWhereQuery, processTransform, getDottedKeys } = require('./query')

const beforeAssociationResolverFactory = (targetModel, { nameFormatter, logger, maxManyAssociations }) => async (findOptions, { dissociate }, context, infos) => {
  logger.indent()
  delete findOptions.graphqlContext
  delete findOptions.logging

  if (findOptions instanceof Promise) {
    findOptions = await findOptions
  }

  findOptions.attributes = [
    ...findOptions.extraAttributes || [],
    ...getRequestedAttributes(targetModel, infos.fieldNodes[0], infos, logger)
  ]

  const {
    includes: nestedIncludes,
    attributes: nestedAttributes
  } = getNestedElements(
    targetModel,
    infos,
    infos.fieldNodes[0],
    infos.variableValues,
    { nameFormatter, logger, maxManyAssociations }
  )

  for (const nestedAttribute of nestedAttributes) {
    if (!findOptions.attributes.includes(nestedAttribute)) {
      findOptions.attributes.push(nestedAttribute)
    }
  }

  // Add keys needed by associations
  const requestedAttributes = infos.fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  logger.log('beforeAssociationResolver', {
    // infos,
    nestedIncludes,
    requestedAttributes
  })

  // TODO : check how is handled multiple include of same model... or merge it correctly !
  findOptions.include = [...findOptions.include || [], ...nestedIncludes]

  logger.log('beforeAssociationResolver', {
    'findOptions.include': findOptions.include,
    'findOptions.attributes': findOptions.attributes
  })

  for (const field of requestedAttributes) {
    const associationFieldName = nameFormatter.fieldNameToModelName(field)
    // if requested attribute is an association
    if (targetModel.associations[associationFieldName] !== undefined) {
      // Active eager load -> left join
      if (targetModel.associations[associationFieldName].associationType === 'BelongsTo') {
        // Add the missing key
        const fkName = targetModel.associations[associationFieldName].options.foreignKey.name
          ? targetModel.associations[associationFieldName].options.foreignKey.name
          : targetModel.associations[associationFieldName].options.foreignKey

        if (!findOptions.attributes.includes(fkName)) {
          findOptions.attributes.push(fkName)
        }
      }
    }
  }

  logger.log('beforeAssociationResolver end', {
    'findOptions.include': findOptions.include,
    'findOptions.attributes': findOptions.attributes
  })
  logger.outdent()

  return findOptions
}

const beforeModelResolverFactory = (targetModel, { nameFormatter, logger }) => async (findOptions, { query }, context, infos) => {
  logger.indent()
  logger.log('beforeModelResolver', { targetModelName: targetModel.name })

  if (findOptions instanceof Promise) {
    findOptions = await findOptions
  }

  if (query !== undefined) {
    // Register transformations and aliases
    if (query.transform !== undefined) {
      for (const attribute of Object.keys(query.transform)) {
        query.transform[attribute] = processTransform(targetModel, query.transform[attribute])
      }
    }

    // Handle the where clause
    if (query.where !== undefined) {
      findOptions.where = cleanWhereQuery(targetModel, query.where)

      const keysSet = new Set(getDottedKeys(findOptions.where).map((k) => k.substring(1, k.length - 1)))
      const keys = Array.from(keysSet.values())
      if (keys.length) {
        const includes = []
        for (const key of keys) {
          const fields = key.split('.')
          const convertToInclude = (tokens, targetModel) => tokens.length > 2
            ? {
                model: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target,
                // as: targetModel.associations[fieldName].as,
                attributes: [],
                include: [convertToInclude(tokens.slice(1), targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target)],
                required: false
              }
            : {
                model: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target,
                // as: targetModel.associations[fieldName].as,
                attributes: [],
                required: false
              }
          includes.push(convertToInclude(fields, targetModel))
        }

        // TODO : check how is handled multiple include of same model... or merge it correctly !
        if (findOptions.include !== undefined) {
          findOptions.include = [...findOptions.include, ...includes]
        } else {
          findOptions.include = includes
        }
      }
    }

    // Handle the without clause
    if (query.without !== undefined) {
      const includes = query.without.map(fieldName => ({
        model: targetModel.associations[nameFormatter.fieldNameToModelName(fieldName)].target,
        // as: targetModel.associations[fieldName].as,
        attributes: [],
        required: false
      }))

      findOptions.where = query.without.reduce((whereClause, fieldName) => ({
        [Sequelize.Op.and]: [
          whereClause,
          targetModel.sequelize.where(
            targetModel.sequelize.col(nameFormatter.fieldNameToModelName(fieldName) + '.' + targetModel.associations[nameFormatter.fieldNameToModelName(fieldName)].target.rawAttributes[targetModel.associations[nameFormatter.fieldNameToModelName(fieldName)].options.foreignKey].field),
            'IS',
            null)
        ]
      }), findOptions.where)

      // TODO : check how is handled multiple include of same model... or merge it correctly !
      if (findOptions.include !== undefined) {
        findOptions.include = [...findOptions.include, ...includes]
      } else {
        findOptions.include = includes
      }
    }

    // Handle the group clause
    if (query.group !== undefined && Array.isArray(query.group) && query.group.length) {
      if (!query.order) {
        query.order = []
      }
      findOptions.separate = true

      const requestedAttributes = getRequestedAttributes(targetModel, infos.fieldNodes[0], infos, logger)
      findOptions.attributes = findOptions.attributes.map(attribute => {
        if (attribute in targetModel.rawAttributes &&
          requestedAttributes.includes(attribute)) {
          if (query.transform && attribute in query.transform) {
            return [query.transform[attribute], attribute]
          } else {
            return attribute
          }
        }

        return null
      })
        .filter(attr => attr !== null)
      findOptions.group = query.group.map(attribute => [query.transform && attribute in query.transform ? query.transform[attribute] : attribute])
    }

    // Handle the order clause
    if (query.order !== undefined &&
      Array.isArray(query.order) &&
      query.order.length &&
      query.order.reduce((ok, field) =>
        ok && Array.isArray(field) &&
        field.length === 2 &&
        ['ASC', 'DESC'].includes(field[1]), true)
    ) {
      let orderMap = []
      for (const [fieldName, order] of query.order) {
        if ((targetModel.rawAttributes[fieldName]?.type instanceof Sequelize.DataTypes.VIRTUAL) &&
          targetModel.rawAttributes[fieldName].type.fields?.length) {
          // Virtual field
          orderMap = orderMap.concat(targetModel.rawAttributes[fieldName].type.fields.map((field) => [field, order]))
        } else if (fieldName.indexOf('.') !== -1) {
          const [associationLocalFieldName, associationFieldName] = fieldName.split('.')
          if (associationLocalFieldName in targetModel.associations) {
            const associatedModel = targetModel.associations[associationLocalFieldName].target
            if ((associatedModel.rawAttributes[associationFieldName]?.type instanceof Sequelize.DataTypes.VIRTUAL) &&
              associatedModel.rawAttributes[associationFieldName].type.fields?.length) {
              orderMap = orderMap.concat(associatedModel.rawAttributes[associationFieldName].type.fields.map((field) => [{ model: associatedModel, as: targetModel.associations[associationLocalFieldName].as }, field, order]))
            } else {
              orderMap.push([fieldName, order])
            }
          }
          // Association
        } else {
          // Raw field
          orderMap.push([fieldName, order])
        }
      }
      findOptions.order = orderMap
    }

    logger.log('beforeModelResolver', { query })

    // Handle the limit clause
    if (query.limit !== undefined) {
      findOptions.limit = query.limit
      // findOptions.subQuery = false
    }
    if (query.offset !== undefined) {
      findOptions.offset = query.offset
    }
  }
  logger.log('findOptions', {
    targetModelName: targetModel.name,
    findOptions
  })
  logger.outdent()
  return findOptions
}

module.exports = {
  beforeAssociationResolverFactory,
  beforeModelResolverFactory,
  beforeResolverFactory: (model, options) => (...args) => beforeModelResolverFactory(model, options)(beforeAssociationResolverFactory(model, options)(...args), ...args.slice(1))
}
