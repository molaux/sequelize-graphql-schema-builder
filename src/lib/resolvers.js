'use strict'
const Sequelize = require('sequelize')
const { getRequestedAttributes } = require('./graphql')
const { getNestedElements } = require('./sequelize')
const { cleanWhereQuery, processTransform, getDottedKeys } = require('./query')
// const { dir } = require('./logger')
const isDeepEqual = require('deep-eql')
const deepmerge = require('deepmerge')

const copyInclude = ({ attributes, include, where, ...rest }) => ({
  attributes: [...attributes ?? []],
  where: where ?? {},
  include: [...include ?? []],
  ...rest
})

const includesMerger = (includes1, includes2) => {
  const result = includes1.map(copyInclude).reduce(
    (result, include1) => {
      const alreadyDefined = result.filter(({ model, as }) => model === include1.model && (!as || !include1.as || as === include1.as))
      if (alreadyDefined.length) {
        for (const iad of alreadyDefined) {
          // attributes
          if (iad.attributes && include1.attributes) {
            iad.attributes = Array.from(new Set([...iad.attributes, ...include1.attributes]))
          } else if (include1.attributes) {
            iad.attributes = include1.attributes
          }

          // include
          // dir('ims', iad.include || [], include1.include || [])
          iad.include = includesMerger(iad.include || [], include1.include || [])

          // where
          if (include1.where && iad.where) {
            // copy where from iad for keys not in include1
            const where = Object
              .keys(iad.where)
              .concat(Object.getOwnPropertySymbols(iad.where))
              .filter((k) => !Object.keys(include1.where).concat(Object.getOwnPropertySymbols(include1.where)).includes(k))
              .reduce((w, k) => ({ ...w, [k]: iad.where[k] }), {})

            for (const k of Object.keys(include1.where).concat(Object.getOwnPropertySymbols(include1.where))) {
              // for keys from include1 beeing in iad
              if (Object.keys(iad.where).concat(Object.getOwnPropertySymbols(iad.where)).includes(k)) {
                // eslint-disable-next-line eqeqeq
                if (isDeepEqual(iad.where[k], include1.where[k])) {
                  where[k] = iad.where[k]
                } else {
                  if (where[Sequelize.Op.or] === undefined) {
                    where[Sequelize.Op.or] = [
                      { [k]: iad.where[k] },
                      { [k]: include1.where[k] }
                    ]
                  } else {
                    where[Sequelize.Op.and] = [
                      { [Sequelize.Op.or]: where[Sequelize.Op.or] },
                      {
                        [Sequelize.Op.or]: [
                          { [k]: iad.where[k] },
                          { [k]: include1.where[k] }
                        ]
                      }
                    ]
                  }
                }
              } else {
                where[k] = include1.where[k]
              }
            }

            iad.where = where
          } else if (include1.where) {
            iad.where = include1.where
          }

          // required
          if (iad.required !== undefined && include1.required !== undefined) {
            iad.required = iad.required && include1.required
          } else if (include1.required !== undefined) {
            iad.required = include1.required
          }
          if (!iad.as && include1.as) {
            iad.as = include1.as
          }
        }

        return result
      } else {
        return [...result, include1]
      }
    },
    includes2.map(copyInclude)
  )
  // dir('result:', result)
  return result
}

const beforeAssociationResolverFactory = (targetModel, { nameFormatter, logger, maxManyAssociations }) => async (findOptions, { dissociate }, context, infos) => {
  logger.indent()
  delete findOptions.graphqlContext
  delete findOptions.logging

  if (findOptions instanceof Promise) {
    findOptions = await findOptions
  }

  findOptions.attributes = Array.from(new Set([
    ...findOptions.extraAttributes || [],
    ...getRequestedAttributes(targetModel, infos.fieldNodes[0], infos, logger)
  ]))

  const {
    includes: nestedIncludes,
    attributes: nestedAttributes
  } = getNestedElements(
    targetModel,
    infos,
    infos.fieldNodes[0],
    infos.variableValues,
    [],
    { nameFormatter, logger, maxManyAssociations }
  )

  findOptions.attributes = Array.from(new Set([...findOptions.attributes, ...nestedAttributes]))
  // for (const nestedAttribute of nestedAttributes) {
  //   if (!findOptions.attributes.includes(nestedAttribute)) {
  //     findOptions.attributes.push(nestedAttribute)
  //   }
  // }

  // Add keys needed by associations
  const requestedAttributes = infos.fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  logger.log('beforeAssociationResolver', {
    // infos,
    nestedIncludes,
    requestedAttributes
  })

  // dir('bar', { foi: findOptions.include || [], nestedIncludes })
  findOptions.include = nestedIncludes // includesMerger(findOptions.include || [], nestedIncludes)

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
      findOptions.where = cleanWhereQuery(targetModel, query.where, undefined, nameFormatter, [])

      const keysSet = new Set(getDottedKeys(findOptions.where).map((k) => k.substring(1, k.length - 1)))
      const keys = Array.from(keysSet.values())
      if (keys.length) {
        const includes = []
        for (const key of keys) {
          const fields = key.split('.')
          const convertToInclude = (tokens, targetModel) => tokens.length > 2
            ? {
                model: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target,
                as: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].as,
                attributes: [],
                include: [convertToInclude(tokens.slice(1), targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target)],
                required: false
              }
            : {
                model: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].target,
                as: targetModel.associations[nameFormatter.fieldNameToModelName(tokens[0])].as,
                attributes: [],
                required: false
              }
          includes.push(convertToInclude(fields, targetModel))
        }

        if (findOptions.include !== undefined) {
          // dir('bmr', { foi: findOptions.includ, includes })
          findOptions.include = includesMerger(findOptions.include, includes)
        } else {
          findOptions.include = includes
        }
      }
    }

    // Handle the without clause
    if (query.without !== undefined) {
      const includes = query.without.map(clause => ({
        model: targetModel.associations[nameFormatter.fieldNameToModelName(clause.field ?? clause)].target,
        // as: targetModel.associations[fieldName].as,
        attributes: [],
        ...(clause.where
          ? {
              where: cleanWhereQuery(targetModel.associations[nameFormatter.fieldNameToModelName(clause.field ?? clause)].target, clause.where, undefined, nameFormatter, [])
            }
          : {}),
        required: false
      }))

      findOptions.where = query.without.reduce((whereClause, clause) => ({
        [Sequelize.Op.and]: [
          whereClause,
          targetModel.sequelize.where(
            targetModel.sequelize.col(nameFormatter.fieldNameToModelName(clause.field ?? clause) + '.' + targetModel.associations[nameFormatter.fieldNameToModelName(clause.field ?? clause)].target.rawAttributes[targetModel.associations[nameFormatter.fieldNameToModelName(clause.field ?? clause)].options.foreignKey].field),
            'IS',
            null)
        ]
      }), findOptions.where)

      if (findOptions.include !== undefined) {
        // dir('bmrw', { foi: findOptions.include, includes })
        findOptions.include = includesMerger(findOptions.include, includes)
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
          const tokens = fieldName.split('.')
          const associationLocalFieldNames = tokens.slice(0, -1)
          const associationFieldName = tokens[tokens.length - 1]
          let model = targetModel
          const nestedAssociations = []
          for (const associationLocalFieldName of associationLocalFieldNames) {
            if (associationLocalFieldName in model.associations) {
              const associatedModel = model.associations[associationLocalFieldName].target
              nestedAssociations.push({ model: associatedModel, as: model.associations[associationLocalFieldName].as })
              model = associatedModel
            }
          }
          if ((model.rawAttributes[associationFieldName]?.type instanceof Sequelize.DataTypes.VIRTUAL) &&
            model.rawAttributes[associationFieldName].type.fields?.length) {
            orderMap = orderMap.concat(model.rawAttributes[associationFieldName].type.fields.map((field) => [...nestedAssociations, field, order]))
          } else {
            // console.log('composed', associationLocalFieldName, associationFieldName, order, associationLocalFieldName in targetModel.associations)
            orderMap.push([...nestedAssociations, associationFieldName, order])
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
  // dir(findOptions)
  return findOptions
}

const findOptionsMerger = (fo1, fo2) => {
  const graphqlContext = fo1.graphqlContext || fo2.graphqlContext
  const include1 = fo1.include
  const include2 = fo2.include
  delete fo1.graphqlContext
  delete fo1.include
  delete fo2.graphqlContext
  delete fo2.include

  const findOptions = deepmerge(fo1, fo2)

  if (include1 && include2) {
    findOptions.include = includesMerger(include1, include2)
  } else if (include1) {
    findOptions.include = include1
  } else if (include2) {
    findOptions.include = include2
  }
  fo1.include = include1
  fo2.include = include2

  if (graphqlContext) {
    fo1.graphqlContext = graphqlContext
    fo2.graphqlContext = graphqlContext
    findOptions.graphqlContext = graphqlContext
  }
  return findOptions
}

module.exports = {
  beforeAssociationResolverFactory,
  includesMerger,
  findOptionsMerger,
  beforeModelResolverFactory,
  beforeResolverFactory: (model, options) => (...args) => beforeModelResolverFactory(model, options)(beforeAssociationResolverFactory(model, options)(...args), ...args.slice(1))
}
