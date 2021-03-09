const Sequelize = require('sequelize')
const { parseGraphQLArgs } = require('./graphql')

const getFieldQuery = (model, fieldNode, variables) => {
  let query = null
  const args = parseGraphQLArgs(fieldNode.arguments, variables)
  if (args.query !== undefined) {
    query = {}
    if (args.query.where !== undefined) {
      query.where = cleanWhereQuery(model, args.query.where)
    }
    if (args.query.required !== undefined) {
      query.required = !!args.query.required
    }
    if (args.query.offset !== undefined) {
      query.offset = args.query.offset
      query.separate = true
    }
    if (args.query.limit !== undefined) {
      query.limit = args.query.limit
      query.separate = true
    }
  }

  // if (args.required !== undefined) {
  //   if (query !== null) {
  //     query.required = args.required
  //   } else {
  //     query = { required: args.required }
  //   }
  // }
  return query
}

const cleanWhereQuery = (model, whereClause, type) => {
  if (typeof whereClause === 'object') {
    if (Object.keys(whereClause).length > 1) {
      // Dive into branches
      for (const key in whereClause) {
        const newQuery = cleanWhereQuery(model, { [key]: whereClause[key] }, type)

        delete whereClause[key]
        whereClause = {
          ...whereClause,
          ...newQuery
        }
      }
      return whereClause
    } else if (Object.keys(whereClause).length === 1) {
      // We have only one key in object in sub query
      let [key] = Object.keys(whereClause)
      let [value] = Object.values(whereClause)
      let finalType = type

      // key process
      if (typeof key === 'string') {
        // is it an operator ?
        const match = key.match(/^_([a-zA-Z]+)Op$/)
        if (match) {
          const op = match[1]
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
          if (key.indexOf('->') !== -1) {
            key = `$${key.replace(/->/g, '.')}$`
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
          case 'INTEGER':
          case 'TINYINT':
          case 'SMALLINT':
            value = Array.isArray(value)
              ? value.map(v => parseInt(v, 10))
              : parseInt(value, 10)
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

module.exports = {
  getFieldQuery,
  cleanWhereQuery
}
