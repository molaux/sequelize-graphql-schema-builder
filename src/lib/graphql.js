const { attributeFields } = require('graphql-sequelize')
const { GraphQLNonNull, GraphQLID } = require('graphql')

const getInsertInputFields = (model, { cache: typesCache, nameFormatter }) => {
  const attributes = attributeFields(model, { cache: typesCache })
  const associationsFk = new Set(Object.values(model.associations)
    .filter(({ associationType }) => associationType === 'BelongsTo' || associationType === 'BelongsToMany')
    .map(({ options: { foreignKey } }) => foreignKey.name ?? foreignKey))

  for (const attribute in attributes) {
    const isID = model.rawAttributes[attribute].primaryKey
    const isNullable = model.rawAttributes[attribute].autoIncrement === true ||
      model.rawAttributes[attribute].defaultValue !== undefined ||
      (model.options.timestamps && ['udpatedAt', 'createdAt'].includes(attribute.name))

    if (associationsFk.has(attribute) && !isID) {
      delete attributes[attribute]
    } else if (isID) {
      attributes[attribute].type = isNullable
        ? GraphQLID
        : new GraphQLNonNull(GraphQLID)
    } else if (isNullable &&
      (attributes[attribute].type instanceof GraphQLNonNull)) {
      attributes[attribute].type = attributes[attribute].type.ofType
    }
  }
  return attributes
}

const getUpdateInputFields = (model, { cache }) => {
  const attributes = attributeFields(model, { cache })
  const associationsFk = new Set(Object.values(model.associations)
    .filter(({ associationType }) => associationType === 'BelongsTo')
    .map(({ options: { foreignKey } }) => foreignKey.name ?? foreignKey))

  for (const attribute in attributes) {
    const isID = model.rawAttributes[attribute].primaryKey

    if (associationsFk.has(attribute) && !isID) {
      delete attributes[attribute]
    } else if (isID) {
      attributes[attribute].type = GraphQLID
    } else if (attributes[attribute].type instanceof GraphQLNonNull) {
      attributes[attribute].type = attributes[attribute].type.ofType
    }
  }
  return attributes
}

const mapAttributes = (model, { fieldNodes }) => {
  // get the fields of the Model (columns of the table)
  const columns = new Set(Object.keys(model.rawAttributes))
  const requestedAttributes = fieldNodes[0].selectionSet.selections
    .map(({ name: { value } }) => value)

  // filter the attributes against the columns
  return requestedAttributes.filter(attribute => columns.has(attribute))
}

const getRequestedAttributes = (model, fieldNode, infos, logger, map) => {
  logger?.indent()
  const attributes = []
  const fieldMap = map
    ? k => map[k] || k
    : k => k
  const columns = new Set(Object.keys(model.rawAttributes))

  if (fieldNode.selectionSet !== undefined && fieldNode.selectionSet.selections !== undefined) {
    const resolvedSelections = resolveFragments(fieldNode.selectionSet.selections, infos)

    for (const field of resolvedSelections) {
      const fieldName = fieldMap(field.name.value)
      // logger.log('getRequestedAttributes', {
      //   field,
      //   fieldName,
      //   'model.associations[fieldName] !== undefined': model.associations[fieldName] !== undefined
      // })

      if (model.associations[fieldName] !== undefined) {
        // attributes = attributes.concat(getNestedAttributes(model.associations[fieldName].target, field).map(nestedAttribute => `${fieldName}.${nestedAttribute}`))
      } else if (columns.has(fieldName)) {
        attributes.push(fieldName)
      }
    }
  }
  logger?.outdent()
  return attributes
}

const parseGraphQLArgs = (arg, variables) => {
  if (arg === undefined) {
    return {}
  } else if (Array.isArray(arg)) {
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

const resolveFragments = (selections, infos) => {
  const resolvedSelections = selections
  for (const field of selections) {
    // Resolve fragments selection
    if (field.kind === 'FragmentSpread') {
      const fragmentName = field.name.value
      const fragment = infos.fragments[fragmentName]

      if (fragment.selectionSet !== undefined && fragment.selectionSet.selections !== undefined) {
        resolvedSelections.push(...fragment.selectionSet.selections)
      }
    }
  }
  return resolvedSelections
}

module.exports = {
  getInsertInputFields,
  getUpdateInputFields,
  mapAttributes,
  getRequestedAttributes,
  parseGraphQLArgs,
  resolveFragments
}
