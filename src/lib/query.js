const Sequelize = require('sequelize')
const { parseGraphQLArgs } = require('./graphql')

const getFieldQuery = (model, fieldNode, variables, nameFormatter, nestedKeys) => {
  let query = null
  const args = parseGraphQLArgs(fieldNode.arguments, variables)
  if (args.query !== undefined) {
    query = {}
    if (args.query.where !== undefined) {
      query.where = cleanWhereQuery(model, args.query.where, undefined, nameFormatter, nestedKeys)
    }
    if (args.query.required !== undefined) {
      query.required = !!args.query.required
    }
    if (args.query.offset !== undefined) {
      query.offset = parseInt(args.query.offset, 10)
      query.separate = true
    }
    if (args.query.limit !== undefined) {
      query.limit = parseInt(args.query.limit, 10)
      query.separate = true
    }
    // if (args.query.transform !== undefined) {
    //   query.transform = {}
    //   for (const attribute of Object.keys(args.query.transform)) {
    //     if (!(query.transform[attribute] instanceof Sequelize.Utils.SequelizeMethod)) {
    //       query.transform[attribute] = processTransform(model, args.query.transform[attribute])
    //     }
    //   }
    // }

    // // Handle the group clause
    // if (args.query.group !== undefined && Array.isArray(args.query.group) && args.query.group.length) {
    //   if (!query.order) {
    //     query.order = []
    //   }
    //   // findOptions.separate = true

    //   // const requestedAttributes = getRequestedAttributes(model, fieldNode, infos, logger)
    //   // findOptions.attributes = findOptions.attributes.map(attribute => {
    //   //   if (attribute in targetModel.rawAttributes &&
    //   //     requestedAttributes.includes(attribute)) {
    //   //     if (query.transform && attribute in query.transform) {
    //   //       return [query.transform[attribute], attribute]
    //   //     } else {
    //   //       return attribute
    //   //     }
    //   //   }

    //   //   return null
    //   // })
    //   //   .filter(attr => attr !== null)
    //   query.group = args.query.group.map(attribute => query.transform && attribute in query.transform ? query.transform[attribute] : attribute)
    //   console.log('group fo')
    //   console.dir(query, { depth: 3 })
    // }
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

const processTransform = (model, transform) => {
  if (typeof transform === 'object') {
    // console.dir({ transform }, { deth: null })
    if (Object.keys(transform).length !== 1) {
      throw new Error(`Transform clause : object should have a unique key: functionName: [ args ]. Got ${JSON.stringify(transform)}`)
    }
    const key = Object.keys(transform)[0]
    if (key === 'literal' && (
      !Array.isArray(transform[key]) ||
      transform[key].length !== 1 ||
      (!['='].includes(transform[key][0]) &&
        !/^[a-z0-9_]+$/ig.test(transform[key][0]))
    )) {
      throw new Error(`Literals arg is restricted to /^[a-z0-9_=]+$/ regex, got [${JSON.stringify(transform[key])}]`)
    }

    if (key === 'fn' && transform[key][0] === 'sub') {
      return model.sequelize.literal(transform[key].slice(1).map(arg =>
        typeof arg === 'object'
          ? model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, arg))
          : `'${arg.replace('\'', '\\\'')}'`
      ).join((' - ')))
    }

    if (key === 'fn' && transform[key][0] === 'add') {
      return model.sequelize.literal(transform[key].slice(1).map(arg =>
        typeof arg === 'object'
          ? model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, arg))
          : `'${arg.replace('\'', '\\\'')}'`
      ).join((' + ')))
    }

    if (key === 'fn' && transform[key][0] === 'equals') {
      return model.sequelize.literal(transform[key].slice(1).map(arg =>
        typeof arg === 'object'
          ? model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, arg))
          : `'${arg.replace('\'', '\\\'')}'`
      ).join((' = ')))
    }

    if (model.sequelize.options.dialect === 'mssql') {
      if (key === 'fn' && transform[key][0] === 'concat') {
        return model.sequelize.literal(transform[key].slice(1).map(arg =>
          typeof arg === 'object'
            ? model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, arg))
            : `'${arg.replace('\'', '\\\'')}'`
        ).join((' + ')))
      }
    }
    if (Array.isArray(transform[key])) {
      return model.sequelize[key](...transform[key].map(arg => processTransform(model, arg)))
    } else {
      throw Error(`${key} does not seem to be transformable...`)
    }
  } else if (transform === '=') {
    return Sequelize.Op.eq
  } else {
    return transform
  }
}

const getDottedKeys = (query) =>
  [...typeof query === 'object'
    ? Object.keys(query).filter((k) => k.indexOf('.') !== -1)
    : Array.isArray(query)
      ? query.map(getDottedKeys)
      : []]

const cleanWhereQuery = (model, whereClause, type, nameFormatter, nestedKeys) => {
  if (Array.isArray(whereClause)) {
    return whereClause.map(value => cleanWhereQuery(model, value, type, nameFormatter, nestedKeys))
  } else if (typeof whereClause === 'object' && whereClause !== null) {
    const cleanedWhereClause = {}

    for (const key of Object.keys(whereClause)) {
      // We have only one key in object in sub query
      let realKey = key
      const value = whereClause[key]
      let finalType = type

      // key process
      // is it an operator ?
      const isLogicOp = key.match(/^_([a-zA-Z]+)Op$/)
      if (isLogicOp) {
        const op = isLogicOp[1]
        if (op !== undefined && op in Sequelize.Op) {
          realKey = Sequelize.Op[op]
          if ([Sequelize.Op.and, Sequelize.Op.or].includes(realKey) && realKey in cleanedWhereClause) {
            cleanedWhereClause[realKey].push(...cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys))
          } else {
            cleanedWhereClause[realKey] = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
          }
          // if (typeof value === 'object' && !Array.isArray(value)) {
          //   const [firstKey] = Object.keys(value)
          //   const match = firstKey.match(/^_([a-zA-Z]+)Op$/)
          //   if (match) {
          //
          //   } else {
          //     cleanedWhereClause[realKey] = model.sequelize.literal(model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, value)))
          //   }
          // }
        } else {
          throw Error(`Op ${op} doesn't exists !`)
        }
      } else {
        if (key === '_Exp') {
          return model.sequelize.literal(model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, value)))
          // return model.sequelize.literal(model.sequelize.dialect.queryGenerator.handleSequelizeMethod(processTransform(model, whereClause)))
        } else if (key.indexOf('__') !== -1 || key.indexOf('!!') !== -1) {
          const negative = key.indexOf('!!') !== -1
          const tokens = !negative
            ? key.split('__')
            : key.split('!!')

          if (!negative && model.rawAttributes[tokens[0]]?.type instanceof Sequelize.DataTypes.JSONB) {
            finalType = Sequelize.DataTypes.JSONB
            const realKey = tokens.join('.')

            cleanedWhereClause[realKey] = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
          } else {
            const modelNames = tokens.slice(0, -1)
            const [attribute] = tokens.slice(-1)
            let targetModel = model

            for (const mn of modelNames) {
              const targetModelName = nameFormatter.fieldNameToModelName(mn)

              // Follow chain for check
              if (targetModelName in targetModel.associations) {
                // Associations
                // const targetKey = getTargetKey(targetModel.associations[targetModelName])
                // const foreignKey = targetModel.associations[targetModelName].foreignKey.name ?? targetModel.associations[targetModelName].foreignKey
                targetModel = targetModel.associations[targetModelName].target
              } else {
                throw Error(`Composed key ${key} is not accessible`)
              }
            }

            if (!(attribute in targetModel.rawAttributes)) {
              throw Error(`Composed key ${key} is not accessible`)
            }

            finalType = targetModel.rawAttributes[attribute].type
            // if (nestedKeys.length) {
            //   throw Error('You cannot use nested column into included models at the present time')
            // }
            const symbol = negative ? '!' : '#'
            realKey = `${symbol}${[...nestedKeys || [], ...modelNames, targetModel.rawAttributes[attribute].field].join('.')}${symbol}`
            cleanedWhereClause[realKey] = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
          }
        } else if (key in model.rawAttributes) {
          // it's not an operator so is it a field of model ?
          realKey = key
          finalType = model.rawAttributes[key].type
          // cleanedWhereClause[realKey] = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
          // key = sequelize.col(key)
          if (model.rawAttributes[key].query) {
            // this is a virtual field using a custom query
            const whereClause = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
            let whereClauseParsed = ''
            let op = Sequelize.Op.eq
            if (Array.isArray(whereClause)) {
              whereClauseParsed = `(${whereClause.map((item) => model.sequelize.dialect.queryGenerator.escape(item, model.rawAttributes[key])).join(', ')})`
              op = Sequelize.Op.in
            } else if (typeof whereClause === 'object') {
              op = Object.getOwnPropertySymbols(whereClause)[0]
              if (Array.isArray(whereClause[op])) {
                whereClauseParsed = `(${whereClause[op].map((item) => model.sequelize.dialect.queryGenerator.escape(item, model.rawAttributes[key])).join(', ')})`
              } else {
                whereClauseParsed = model.sequelize.dialect.queryGenerator.escape(whereClause[op], model.rawAttributes[key])
              }
            } else {
              whereClauseParsed = model.sequelize.dialect.queryGenerator.escape(whereClause, model.rawAttributes[key])
            }
            if (Sequelize.Op.and in cleanedWhereClause) {
              cleanedWhereClause[realKey].push(Sequelize.literal(`(${model.rawAttributes[key].query}) ${model.sequelize.dialect.queryGenerator.OperatorMap[op]} ${whereClauseParsed}`))
            } else {
              cleanedWhereClause[Sequelize.Op.and] = Sequelize.literal(`(${model.rawAttributes[key].query}) ${model.sequelize.dialect.queryGenerator.OperatorMap[op]} ${whereClauseParsed}`)
            }
          } else {
            cleanedWhereClause[realKey] = cleanWhereQuery(model, value, finalType, nameFormatter, nestedKeys)
          }
        } else {
          // Error !!!
          throw Error(`Sequelize GraphQL schema builder : unknown field «${key}»! Should be in ${Object.keys(model.rawAttributes).join(', ')}.`)
        }
      }
    }

    return cleanedWhereClause
  } else {
    if (whereClause !== null) {
      switch (`${type}`) {
        case 'DATETIMEOFFSET':
          if (model.sequelize.options.dialect === 'mssql') {
            return Sequelize.cast(new Date(Date.parse(whereClause)), 'DATETIMEOFFSET')
          }
          break
        case 'INTEGER':
        case 'TINYINT':
        case 'SMALLINT':
          return parseInt(whereClause, 10)
        case 'DECIMAL':
          return parseFloat(whereClause)
        case 'JSONB':
          // We may have to use some kinf of typing syntax as JSONB does not provide fields types
          return whereClause
      }
    }

    return whereClause
  }
}

module.exports = {
  getFieldQuery,
  cleanWhereQuery,
  getDottedKeys,
  processTransform
}
