'use strict'
const Sequelize = require('sequelize')
const DataTypes = require('sequelize/lib/data-types')
const { getRequestedAttributes } = require('./graphql')
const { getNestedElements } = require('./sequelize')
const { cleanWhereQuery } = require('./query')

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
    // Manage the where clause
    if (query.where !== undefined) {
      findOptions.where = cleanWhereQuery(targetModel, query.where)
    }

    // Manage the without clause
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
      if (findOptions.include !== undefined) {
        findOptions.include = [...findOptions.include, ...includes]
      } else {
        findOptions.include = includes
      }
    }

    // Manage the group clause
    if (query.group !== undefined && Array.isArray(query.group) && query.group.length) {
      findOptions.order = query.group
      const requestedAttributes = getRequestedAttributes(targetModel, infos.fieldNodes[0], infos, logger)
      findOptions.attributes = findOptions.attributes.map(attribute => {
        if (query.group.includes(attribute)) {
          // if attr is grouped against, return as is
          return attribute
          // Don't auto-agregate fields nested by associations
        } else if (attribute in targetModel.rawAttributes && requestedAttributes.includes(attribute)) {
          const dataType = targetModel.rawAttributes[attribute].type
          if (dataType instanceof DataTypes.DECIMAL) {
            return [targetModel.sequelize.fn('SUM', targetModel.sequelize.col(attribute)), attribute]
          } else if (dataType instanceof DataTypes.DATE || dataType instanceof DataTypes.DATEONLY) {
            return [targetModel.sequelize.fn('MAX', targetModel.sequelize.col(attribute)), attribute]
          } else { // TODO: add more aggregations types
            return [targetModel.sequelize.fn('AVG', targetModel.sequelize.col(attribute)), attribute]
          }
        }
        // throw new Error('group attr inconsistancy, should not happen')
        return null
      })
        .filter(attr => attr !== null)

      findOptions.group = Array.isArray(query.group[0])
        ? query.group.map(group => [group[0]])
        : [query.group]
    }

    // Manage the order clause
    if (query.order !== undefined &&
      Array.isArray(query.order) &&
      query.order.length &&
      query.order.reduce((ok, field) =>
        ok && Array.isArray(field) &&
        field.length === 2 &&
        ['ASC', 'DESC'].includes(field[1]), true)
    ) {
      findOptions.order = query.order
    }

    logger.log('beforeModelResolver', { query })

    // Manage the limit clause
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
