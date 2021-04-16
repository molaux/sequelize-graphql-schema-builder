const pluralize = require('pluralize')

const nameFormatterFactory = namespace => ({
  namespace,
  modelToFieldMap: new Map(),
  fieldToModelMap: new Map(),
  namespaceize: function (name) { return this.namespace && this.namespace.length ? `${this.namespace}${name}` : name },
  formatModelName: function (modelName) { return this.namespaceize(modelName[0].toUpperCase() + modelName.substr(1)) },
  formatManyModelName: function (modelName) {
    const formattedModelName = this.formatModelName(modelName)
    const manyFormattedModelName = pluralize(formattedModelName)
    return manyFormattedModelName === formattedModelName ? `${formattedModelName}s` : manyFormattedModelName
  },
  formatModelNameAsField: function (modelName) { return modelName },
  formatTypeName: function (type) { return this.formatModelName(type) },
  formatValidatorTypeName: function (type) { return `${this.formatModelName(type)}Validator` },
  formatInsertInputTypeName: function (type, throughType) { return `${this.formatModelName(type)}CreateInput${throughType ? `Through${this.formatModelName(throughType)}` : ''}` },
  formatUpdateInputTypeName: function (type) { return `${this.formatModelName(type)}UpdateInput` },
  formatQueryName: function (modelName) { return this.formatModelName(modelName) },
  formatModelValidatorQueryName: function (type) { return `${this.formatModelName(type)}Validator` },
  formatInsertMutationName: function (modelName) { return `create${this.formatModelName(modelName)}` },
  formatDeleteMutationName: function (modelName) { return `delete${this.formatModelName(modelName)}` },
  formatUpdateMutationName: function (modelName) { return `update${this.formatModelName(modelName)}` },
  formatMockMutationName: function (modelName) { return `mock${this.formatModelName(modelName)}` },
  formatManyQueryName: function (modelName) {
    const formattedQueryName = this.formatQueryName(modelName)
    const manyFormattedQueryName = pluralize(formattedQueryName)
    return manyFormattedQueryName === formattedQueryName ? `${formattedQueryName}s` : manyFormattedQueryName
  },
  modelNameToFieldName: function (modelName, singularModelName) {
    if (!this.modelToFieldMap.has(modelName)) {
      const fieldName = this.formatModelNameAsField(modelName)
      this.modelToFieldMap.set(modelName, fieldName)
      this.fieldToModelMap.set(fieldName, singularModelName)
      return fieldName
    } else {
      return this.modelToFieldMap.get(modelName)
    }
  },
  fieldNameToModelName: function (fieldName) {
    if (!this.fieldToModelMap.has(fieldName)) {
      return fieldName
    }
    return this.fieldToModelMap.get(fieldName)
  },
  formatCreatedSubscriptionName: function (modelName) { return `created${this.formatModelName(modelName)}` },
  formatUpdatedSubscriptionName: function (modelName) { return `updated${this.formatModelName(modelName)}` },
  formatDeletedSubscriptionName: function (modelName) { return `deleted${this.formatModelName(modelName)}` }
})

module.exports = {
  nameFormatterFactory
}
