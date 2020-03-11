'use strict'
const Sequelize = require('sequelize')
const DataTypes = require('sequelize/lib/data-types')

// const util = require('util')

const mapAttributes = (model, { fieldNodes }) => {
  // console.log(fieldNodes)
  // get the fields of the Model (columns of the table)
  const columns = new Set(Object.keys(model.rawAttributes))
  const requestedAttributes = fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  // filter the attributes against the columns
  return requestedAttributes.filter(attribute => columns.has(attribute))
}

const getRequestedAttributes = (model, fieldNode, map) => {
  let attributes = []
  const fieldMap = map 
    ? k => map[k] || k
    : k => k
  const columns = new Set(Object.keys(model.rawAttributes))

  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    for (let field of fieldNode.selectionSet.selections) {
      let fieldName = fieldMap(field.name.value)

      if (model.associations[fieldName] !== undefined) {
        // attributes = attributes.concat(getNestedAttributes(model.associations[fieldName].target, field).map(nestedAttribute => `${fieldName}.${nestedAttribute}`))
      } else if (columns.has(fieldName)) {
        attributes.push(fieldName)
      }
    }
  }
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

const getNestedIncludes = (model, fieldNode, variables) => {
  let includes = []
  let attributes = []
  let countManyAssociation = 0
  const maxManyAssociations = 2 // Prevent multi left joins
  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    for (let field of fieldNode.selectionSet.selections) {
      let fieldName = field.name.value
      if (model.associations[fieldName] !== undefined) {
        let include = {
          model: model.associations[fieldName].target,
          as: model.associations[fieldName].as,
          attributes: getRequestedAttributes(model.associations[fieldName].target, field)
        }

        if (model.associations[fieldName].associationType === 'BelongsTo') {
          // Add the missing key
          if (!attributes.includes(model.associations[fieldName].options.foreignKey)) {
            attributes.push(model.associations[fieldName].options.foreignKey)
          }
        } else if (model.associations[fieldName].associationType === 'HasMany') {
          if (++countManyAssociation > maxManyAssociations) {
            continue
          }
          // Add the missing key
          if (model.associations[fieldName].options.targetKey !== undefined &&
            !attributes.includes(model.associations[fieldName].options.targetKey)) {
            attributes.push(model.associations[fieldName].options.targetKey)
          } else {
            for (let pk in model.primaryKeys) {
              if (!attributes.includes(pk)) {
                attributes.push(pk)
              }
            }
          }
        }

        let [ nestedIncludes, nestedAttributes ] = getNestedIncludes(model.associations[fieldName].target, field, variables)
        for (let nestedAttribute of nestedAttributes) {
          if (!include.attributes.includes(nestedAttribute)) {
            include.attributes.push(nestedAttribute)
          }
        }
        if (nestedIncludes.length) {
          include.include = nestedIncludes
        }
        let fieldQuery = getFieldQuery(model.associations[fieldName].target, field, variables)
        if (fieldQuery !== null) {
          include = { ...include, ...fieldQuery }
        }
        includes.push(include)
      }
    }
  }
  return [ includes, attributes ]
}

const cleanWhereQuery = (model, whereClause, type) => {
  // console.log(model.name, whereClause)
  if (typeof whereClause === 'object') {
    if (Object.keys(whereClause).length > 1) {
      // Dive into branches
      for (let key in whereClause) {
        let newQuery = cleanWhereQuery(model, { [key]: whereClause[key] }, key)

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
          // console.log(key)
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
            // console.log('DATETIMEOFFSET', value, Date.parse(value))
            value = Sequelize.cast(new Date(Date.parse(value)), 'DATETIMEOFFSET')
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

const beforeAssociationResolver = (targetModel) => (findOptions, { query }, context, infos) => {
  findOptions.attributes = [
    ...findOptions.extraAttributes || [],
    ...getRequestedAttributes(targetModel, infos.fieldNodes[0])
  ]
  // console.log('beforeAssociationResolver', findOptions.attributes)

  const [ nestedIncludes, nestedAttributes ] = getNestedIncludes(targetModel, infos.fieldNodes[0], infos.variableValues)

  for (let nestedAttribute of nestedAttributes) {
    if (!findOptions.attributes.includes(nestedAttribute)) {
      findOptions.attributes.push(nestedAttribute)
    }
  }
  // console.log(targetModel.name, util.inspect(infos, false, null, true /* enable colors */))
  // console.log(targetModel.name, util.inspect(findOptions, false, null, true /* enable colors */))

  // Add keys needed by associations
  const requestedAttributes = infos.fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  findOptions.include = [ ...findOptions.include || [], ...nestedIncludes ]

  for (let field of requestedAttributes) {
    // if requested attribute is an association
    // console.log(`## Model ${targetModel.name} : associations (search for ${field}) :`, Object.keys(targetModel.associations))
    if (targetModel.associations[field] !== undefined) {
      // console.log(`## Model ${targetModel.name} : association ${field} will eager load ${targetModel.associations[field].target.name} known as ${targetModel.associations[field].as}`)
      // Active eager load -> left join

      // findOptions.include.push({ model: targetModel.associations[field].target, as: targetModel.associations[field].as })

      if (targetModel.associations[field].associationType === 'BelongsTo') {
        // Add the missing key
        if (!findOptions.attributes.includes(targetModel.associations[field].options.foreignKey)) {
          findOptions.attributes.push(targetModel.associations[field].options.foreignKey)
        }
      }
    }
  }

  return findOptions
}

const beforeModelResolver = (targetModel) => (findOptions, { query }, context, infos) => {
  // console.log('##beforeModelResolver', targetModel.name,  context, infos)
  // If a query has been submitted with association field
  // attributes: [[sequelize.fn('min', sequelize.col('price')), 'minPrice']],
  if (query !== undefined) {
    // Manage the where clause
    if (query.where !== undefined) {
      findOptions.where = cleanWhereQuery(targetModel, query.where)
    }

    // Manage the without clause
    if (query.without !== undefined) {
      const includes = query.without.map(fieldName => ({
        model: targetModel.associations[fieldName].target,
        // as: targetModel.associations[fieldName].as,
        attributes: [],
        required: false
      }))
      findOptions.where = query.without.reduce((whereClause, fieldName) => ({
        [Sequelize.Op.and]: [
          whereClause,
          targetModel.sequelize.where(
            targetModel.sequelize.col(fieldName + '.' + targetModel.associations[fieldName].target.rawAttributes[targetModel.associations[fieldName].options.foreignKey].field),
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
      const requestedAttributes = getRequestedAttributes(targetModel, infos.fieldNodes[0])
      // console.log(requestedAttributes)
      findOptions.attributes = findOptions.attributes.map(attribute => {
        // console.log(attribute)
        if (query.group.includes(attribute)) {
          // if attr is grouped against, return as is
          return attribute
          // Don't auto-agrregate fields nested by associations 
        } else if (attribute in targetModel.rawAttributes && requestedAttributes.includes(attribute)) {
          // console.log(attribute, '###')
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
    // console.log(query)
    // Manage the limit clause
    if (query.limit !== undefined) {
      findOptions.limit = query.limit
      findOptions.subQuery = false
    }
  }
  // console.log(targetModel.name, util.inspect(infos, false, null, true /* enable colors */))

  return findOptions
}

module.exports = {
  mapAttributes,
  getRequestedAttributes,
  parseGraphQLArgs,
  getNestedIncludes,
  getFieldQuery,
  cleanWhereQuery,
  beforeAssociationResolver,
  beforeModelResolver,
  beforeResolver: model => (...args) => beforeModelResolver(model)(beforeAssociationResolver(model)(...args), ...args.slice(1))
}
