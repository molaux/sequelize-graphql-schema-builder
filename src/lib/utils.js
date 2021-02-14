'use strict'
const Sequelize = require('sequelize')
const DataTypes = require('sequelize/lib/data-types')
const deepmerge = require('deepmerge')
const ucfirst = require('ucfirst')
const pluralize = require('pluralize')
const util = require('util')

const loggerFactory = active => ({
  log: active 
    ? (namespace, value) => console.log(namespace, util.inspect(value, false, null, true /* enable colors */))
    : () => null,
  indent: () => active 
    ? console.group()
    : () => null,
  outdent: () => active 
    ? console.groupEnd()
    : () => null
})

const nameFormatterFactory = namespace => ({
  namespace,
  modelToFieldMap: new Map(),
  fieldToModelMap: new Map(),
  namespaceize:  function (name) { return namespace && namespace.length ? `${namespace}_${name}` : name },
  formatModelName: function (modelName) { return this.namespaceize(ucfirst(modelName)) },
  formatManyModelName: function (modelName) {
    const formattedModelName = this.formatModelName(modelName)
    const manyFormattedModelName = pluralize(formattedModelName)
    return manyFormattedModelName === formattedModelName ? `${formattedModelName}s` : manyFormattedModelName
  },
  formatModelNameAsField: function (modelName) { return modelName[0].toLowerCase() + modelName.substr(1) },
  formatTypeName: function (type) { return this.formatModelName(type) },
  modelToFieldName: function (modelName, singularModelName) {
    if (!this.modelToFieldMap.has(modelName)) {
      const fieldName = this.formatModelNameAsField(modelName)
      this.modelToFieldMap.set(modelName, fieldName)
      this.fieldToModelMap.set(fieldName, singularModelName)
      return fieldName
    } else {
      return this.modelToFieldMap.get(modelName)
    }

  },
  fieldToModelName: function (fieldName) {
    if (!this.fieldToModelMap.has(fieldName)) {
      return fieldName
    }
    return this.fieldToModelMap.get(fieldName)
  }
})

const mapAttributes = (model, { fieldNodes }) => {
  // get the fields of the Model (columns of the table)
  const columns = new Set(Object.keys(model.rawAttributes))
  const requestedAttributes = fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  // filter the attributes against the columns
  return requestedAttributes.filter(attribute => columns.has(attribute))
}

const getRequestedAttributes = (model, fieldNode, logger, map) => {
  logger.indent()
  let attributes = []
  const fieldMap = map 
    ? k => map[k] || k
    : k => k
  const columns = new Set(Object.keys(model.rawAttributes))

  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    for (let field of fieldNode.selectionSet.selections) {
      let fieldName = fieldMap(field.name.value)
      logger.log('getRequestedAttributes', {
        field,
        fieldName,
        'model.associations[fieldName] !== undefined': model.associations[fieldName] !== undefined
      })

      if (model.associations[fieldName] !== undefined) {
        // attributes = attributes.concat(getNestedAttributes(model.associations[fieldName].target, field).map(nestedAttribute => `${fieldName}.${nestedAttribute}`))
      } else if (columns.has(fieldName)) {
        attributes.push(fieldName)
      }
    }
  }
  logger.outdent()
  return attributes
}

const parseGraphQLArgs = (arg, variables) => {
  if (Array.isArray(arg)) {
    return arg.filter(arg => ['Argument', 'ObjectField'].includes(arg.kind)).reduce((o, arg) => {
      o[arg.name.value] = parseGraphQLArgs(arg.value, variables)
      return o
    }, {})
  } else if (arg.kind === 'ObjectValue') {
    return parseGraphQLArgs(arg.fields, variables)
  } else if (arg.kind === 'ListValue') {
    return arg.values.map(value => parseGraphQLArgs(value, variables))
  } else if (arg.kind === 'Variable') {
    return variables[arg.name.value]
  } else {
    return arg.value
  }
}

const getFieldQuery = (model, fieldNode, variables) => {
  let query = null
  let args = parseGraphQLArgs(fieldNode.arguments, variables)
  if (args.query !== undefined) {
    if (args.query.where !== undefined) {
      query = { where: cleanWhereQuery(model, args.query.where), required: false }
    }
  }

  if (args.required !== undefined) {
    if (query !== null) {
      query.required = args.required
    } else {
      query = { required: args.required }
    }
  }
  return query
}

const getNestedIncludes = (model, fieldNode, variables, { nameFormatter, logger }) => {
  logger.indent()
  let includes = []
  let attributes = []
  let countManyAssociation = 0
  const maxManyAssociations = 10 // Prevent multi left joins
  logger.log('getNestedIncludes', {fieldNode})
  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    for (let field of fieldNode.selectionSet.selections) {
      const fieldName = nameFormatter.fieldToModelName(field.name.value)
      logger.log('getNestedIncludes', {
        fieldName,
        'field.name.value': field.name.value,
        'model.associations': model.associations
      })

      if (model.associations[fieldName] !== undefined) {
        let include = {
          model: model.associations[fieldName].target,
          as: model.associations[fieldName].as,
          attributes: getRequestedAttributes(model.associations[fieldName].target, field, logger)
        }
        logger.log('getNestedIncludes', {
          fieldName,
          'model.associations[fieldName] !== undefined': true,
          include
        })

        if (model.associations[fieldName].associationType === 'BelongsTo') {
          logger.log('getNestedIncludes', {
            fieldName,
            type: 'BelongsTo',
            fk: model.associations[fieldName].options.foreignKey
          })

          // Add the missing key
          if (!attributes.includes(model.associations[fieldName].options.foreignKey.name)) {
            attributes.push(model.associations[fieldName].options.foreignKey.name)
          }
        } else if (['HasMany', 'BelongsToMany'].includes(model.associations[fieldName].associationType)) {
          logger.log('getNestedIncludes', {
            fieldName,
            type: 'Many'
          })
          if (++countManyAssociation > maxManyAssociations) {
            // TODO : avoid include associations with agreggation query
            continue
          }
          // Add the missing key
          if (model.associations[fieldName].options.targetKey !== undefined &&
            !attributes.includes(model.associations[fieldName].options.targetKey.name)) {
            attributes.push(model.associations[fieldName].options.targetKey.name)
          } else {
            for (let pk in model.primaryKeys) {
              if (!attributes.includes(pk)) {
                attributes.push(pk)
              }
            }
          }
        }

        logger.log('getNestedIncludes', {
          fieldName,
          include
        })

        let [ nestedIncludes, nestedAttributes ] = getNestedIncludes(model.associations[fieldName].target, field, variables, { nameFormatter, logger })

        for (let nestedAttribute of nestedAttributes) {
          if (!include.attributes.includes(nestedAttribute)) {
            include.attributes.push(nestedAttribute)
          }
        }

        if (nestedIncludes.length) {
          include.include = nestedIncludes
        }

        const fieldQuery = getFieldQuery(model.associations[fieldName].target, field, variables)

        if (fieldQuery !== null) {
          include = { ...include, ...fieldQuery }
        }
        includes.push(include)
      }
    }
  }
  logger.outdent()
  return [ includes, attributes ]
}

const cleanWhereQuery = (model, whereClause, type) => {

  if (typeof whereClause === 'object') {
    if (Object.keys(whereClause).length > 1) {
      // Dive into branches
      for (let key in whereClause) {
        let newQuery = cleanWhereQuery(model, { [key]: whereClause[key] }, type)

        delete whereClause[key]
        whereClause = {
          ...whereClause,
          ...newQuery
        }
      }
      return whereClause
    } else if (Object.keys(whereClause).length === 1) {
      // We have only one key in object in sub query
      let [ key ] = Object.keys(whereClause)
      let [ value ] = Object.values(whereClause)
      let finalType = type

      // key process
      if (typeof key === 'string') {
        // is it an operator ?
        let match = key.match(/^_([a-zA-Z]+)Op$/)
        if (match) {
          let op = match[1]
          if (op !== undefined && op in Sequelize.Op) {
            key = Sequelize.Op[op]
          } else {
            throw Error(`Op ${op} doesn't exists !`)
          }
        } else if (key in model.rawAttributes) {
          // it's not an operator so is it a field of model ?
          finalType = model.rawAttributes[key].type
          // key = sequelize.col(key)
        }
        // dot is not allowed in graphql keys
        if (typeof key === 'string') {
          if (key.indexOf('_') !== -1) {
            key = `$${key.replace(/_/g, '.')}$`
          }
        }
      } else {
        throw Error('key should always be a string !')
      }

      // value process
      if (typeof value === 'object' && !Array.isArray(value)) {
        return { [key]: cleanWhereQuery(model, value, finalType) }
      } else {
        switch (`${finalType}`) {
          case 'DATETIMEOFFSET':
            if (model.sequelize.options.dialect === 'mssql') {
              value = Sequelize.cast(new Date(Date.parse(value)), 'DATETIMEOFFSET')
            }
            break
        }

        return { [key]: value }
      }
    } else {
      return {}
    }
  } else {
    throw Error('Where clause should always be an object !')
  }
}

const beforeAssociationResolver = (targetModel, { nameFormatter, logger }) => async (findOptions, { query }, context, infos) => {
  logger.indent()
  logger.log('beforeAssociationResolver', {
    'targetModel.name': targetModel.name
  })

  if (findOptions instanceof Promise) {
    findOptions = await findOptions
  }

  findOptions.attributes = [
    ...findOptions.extraAttributes || [],
    ...getRequestedAttributes(targetModel, infos.fieldNodes[0], logger)
  ]


  const [ nestedIncludes, nestedAttributes ] = getNestedIncludes(targetModel, infos.fieldNodes[0], infos.variableValues, { nameFormatter, logger })

  for (let nestedAttribute of nestedAttributes) {
    if (!findOptions.attributes.includes(nestedAttribute)) {
      findOptions.attributes.push(nestedAttribute)
    }
  }

  // Add keys needed by associations
  const requestedAttributes = infos.fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  logger.log('beforeAssociationResolver', {
    //infos,
    nestedIncludes,
    requestedAttributes
  })

  findOptions.include = [ ...findOptions.include || [], ...nestedIncludes ]

  logger.log('beforeAssociationResolver', {
    'findOptions.include': findOptions.include, 
    'findOptions.attributes': findOptions.attributes
  })

  for (let field of requestedAttributes) {
    const associationFieldName = nameFormatter.fieldToModelName(field)
    // if requested attribute is an association
    if (targetModel.associations[associationFieldName] !== undefined) {
      // Active eager load -> left join
      if (targetModel.associations[associationFieldName].associationType === 'BelongsTo') {
        // Add the missing key
        if (!findOptions.attributes.includes(targetModel.associations[associationFieldName].options.foreignKey.name)) {
          findOptions.attributes.push(targetModel.associations[associationFieldName].options.foreignKey.name)
        }
      }
    }
  }

  logger.log('beforeAssociationResolver', {
    'findOptions.include': findOptions.include,
    'findOptions.attributes': findOptions.attributes
  })
  logger.outdent()

  return findOptions
}

const beforeModelResolver = (targetModel, { nameFormatter, logger }) => async (findOptions, { query }, context, infos) => {
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
        model: targetModel.associations[nameFormatter.fieldToModelName(fieldName)].target,
        // as: targetModel.associations[fieldName].as,
        attributes: [],
        required: false
      }))

      findOptions.where = query.without.reduce((whereClause, fieldName) => ({
        [Sequelize.Op.and]: [
          whereClause,
          targetModel.sequelize.where(
            targetModel.sequelize.col(nameFormatter.fieldToModelName(fieldName) + '.' + targetModel.associations[nameFormatter.fieldToModelName(fieldName)].target.rawAttributes[targetModel.associations[nameFormatter.fieldToModelName(fieldName)].options.foreignKey].field),
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
      const requestedAttributes = getRequestedAttributes(targetModel, infos.fieldNodes[0], logger)
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
          } { // TODO: add more aggregations types
            return [targetModel.sequelize.fn('AVG', targetModel.sequelize.col(attribute)), attribute]
          }
        }
      })

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
      findOptions.subQuery = false
    }
  }
  logger.log('beforeModelResolver', {
    targetModelName: targetModel.name, 
    findOptionsInclude: findOptions.include
  })
  logger.outdent()

  return findOptions
}

const findOptionsMerger = (fo1, fo2) => {
  const graphqlContext = fo1.graphqlContext || fo2.graphqlContext
  delete fo1.graphqlContext
  delete fo2.graphqlContext

  const findOptions = deepmerge(fo1, fo2)

  if ('include' in findOptions) {
    const reducedInclude = new Map()
    for (const include of findOptions.include) {
      if (!reducedInclude.has(include.model)) {
        reducedInclude.set(include.model, include)
      } else {
        reducedInclude.set(include.model, findOptionsMerger(reducedInclude.get(include.model), include))
      }
    }
    findOptions.include = Array.from(reducedInclude.values())
  }
  if (graphqlContext) {
    fo1.graphqlContext = graphqlContext
    fo2.graphqlContext = graphqlContext
    findOptions.graphqlContext = graphqlContext
  }
  return findOptions
}

module.exports = {
  loggerFactory,
  nameFormatterFactory,
  mapAttributes,
  getRequestedAttributes,
  parseGraphQLArgs,
  getNestedIncludes,
  getFieldQuery,
  cleanWhereQuery,
  beforeAssociationResolver,
  beforeModelResolver,
  findOptionsMerger,
  beforeResolver: (model, options) => (...args) => beforeModelResolver(model, options)(beforeAssociationResolver(model, options)(...args), ...args.slice(1))
}
