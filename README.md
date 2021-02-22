# Graphql Sequelize R

This project is an experimental work that aims to bring relations and miscellaneous features on top of [graphql-sequelize](https://github.com/mickhansen/graphql-sequelize).

The `sequelizeToGraphQLSchemaBuilder` builds queries, mutations and types needed to build a complete GraphQL API according to your Sequelize models and associations. Generated queries and insertions are able to resolve nested associations, so the GraphQL schema is tight to the Sequelize schema.
  
## Installation

$ npm install --save @molaux/graphql-sequelize-r

graphql-sequelize-r assumes you have graphql and sequelize installed.

## Use

```javascript
const { sequelizeToGraphQLSchemaBuilder } = require('@molaux/graphql-sequelize-r')

const schema = sequelize => {
  const {
    modelsTypes: sequelizeModelsTypes,
    queries: sequelizeModelsQueries,
    // TODO: mutations: sequelizeModelsMutations
  } = sequelizeToGraphQLSchemaBuilder(sequelize)

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'RootQueryType',
      fields: () => sequelizeModelsTypes,
    }),
    subscription: new GraphQLObjectType({
      name: 'RootSubscriptionType',
      fields: () => {} // Your subscriptions here
    }),
    mutation: new GraphQLObjectType({
      name: 'RootMutationType',
      fields: () => sequelizeModelsMutations
    })
  })
}
```

## GraphQL API

This documentation is based on the [GraphQL Sequelize R example](https://github.com/molaux/graphql-sequelize-r-example).

### Introduction

The api will shape like this :

```gql
query {
  staffs {
    firstName
    fullName
    store { 
      manager {
      	firstName
      }
      staffs {
        firstName
      }
    }
    asManagerStores { 
      staffs {
        fullName
      }
    }
    address {
      address
    }
  }
}
```

```json
{
  "data": {
    "staffs": [
      {
        "firstName": "Mike",
        "fullName": "Mike HILLYER",
        "store": null,
        "asManagerStores": [],
        "address": {
          "address": "23 Workhaven Lane"
        }
      },
      {
        "firstName": "Jon",
        "fullName": "Jon STEPHENS",
        "store": {
          "manager": {
            "firstName": "Jon"
          },
          "staffs": [
            {
              "firstName": "Jon"
            }
          ]
        },
        "asManagerStores": [
          {
            "staffs": [
              {
                "fullName": "Jon STEPHENS"
              }
            ]
          }
        ],
        "address": {
          "address": "1411 Lillydale Drive"
        }
      }
    ]
  }
}
```

Note the nested associations : here `Store` and `Staff` are linked by 2 foreign keys. 

[In the example](https://github.com/molaux/graphql-sequelize-r-example/tree/master/src/models/sakila/extensions/Staff.cjs), `Staff.firstName` has a getter that transforms raw data into upper case, and `Staff.fullName` is a `Sequelize` `VIRTUAL` field.

The corresponding SQL query is composed of multiple joins, and only needed fields to respond to the GraphQL query are pulled (and those needed by JOINs and VIRTUAL fields)

```sql
SELECT 
  `Staff`.`first_name` AS `firstName`,
  `Staff`.`store_id` AS `storeId`,
  `Staff`.`staff_id` AS `staffId`,
  `Staff`.`address_id` AS `addressId`,
  `Staff`.`last_name` AS `lastName`,
  `Store`.`manager_staff_id` AS `Store.managerStaffId`,
  `Store`.`store_id` AS `Store.storeId`,
  `Store->Manager`.`staff_id` AS `Store.Manager.staffId`,
  `Store->Manager`.`first_name` AS `Store.Manager.firstName`,
  `Store->Staffs`.`staff_id` AS `Store.Staffs.staffId`,
  `Store->Staffs`.`first_name` AS `Store.Staffs.firstName`,
  `AsManagerStore`.`store_id` AS `AsManagerStore.storeId`,
  `AsManagerStore->Staffs`.`staff_id` AS `AsManagerStore.Staffs.staffId`,
  `AsManagerStore->Staffs`.`first_name` AS `AsManagerStore.Staffs.firstName`,
  `AsManagerStore->Staffs`.`last_name` AS `AsManagerStore.Staffs.lastName`,
  `Address`.`address_id` AS `Address.addressId`, 
  `Address`.`address` AS `Address.address`

FROM `staff` AS `Staff`

LEFT OUTER JOIN `store` AS `Store`
  ON `Staff`.`store_id` = `Store`.`store_id` 

LEFT OUTER JOIN `staff` AS `Store->Manager`
  ON `Store`.`manager_staff_id` = `Store->Manager`.`staff_id`

LEFT OUTER JOIN `staff` AS `Store->Staffs`
  ON `Store`.`store_id` = `Store->Staffs`.`store_id`

LEFT OUTER JOIN `store` AS `AsManagerStore`
  ON `Staff`.`staff_id` = `AsManagerStore`.`manager_staff_id`
 
LEFT OUTER JOIN `staff` AS `AsManagerStore->Staffs`
  ON `AsManagerStore`.`store_id` = `AsManagerStore->Staffs`.`store_id`

LEFT OUTER JOIN `address` AS `Address`
  ON `Staff`.`address_id` = `Address`.`address_id`
  
ORDER BY `Staff`.`staff_id` ASC
```
### required
```gql
query {
  staffs {
    fullName
    store(required: true) { 
      manager {
      	firstName
    	}
    }
  }
}
```
This time, "Mike HILLYER" is excluded, since he has no `Store`.

### query

#### where
```gql
query {
  films(query: { 
    where: {
      length: {
        _andOp: { 
          _gteOp: 60,
          _lteOp: 70,
        }
      },
      releaseYear: 2006
    }
  }) {
    length
    title
    releaseYear
    filmActors {
      actor {
      	lastName
      }
    }
  }
}
```
Here, we juste want films for witch length is in [60, 70], and released in 2006 (there is no other release date in the database);

Operators should formatted in this way : `_${operator}Op` where `operator` is a key from `Sequelize.Op`.

```gql
query {
  films(query: { 
    where: {
      length: {
        _andOp: { 
          _gteOp: 60,
          _lteOp: 70,
        }
      },
      releaseYear: 2006
    }
  }) {
    length
    title
    releaseYear
    filmActors(required: true) {
      actor (required: true, query: {
        where: {
          lastName: "DEAN"
        }
      }) {
      	firstName
        lastName
      }
    }
  }
}
```

The same request as above, but this time we filter movies having actors named "DEAN".

#### order

To be documented

#### group

To be documented

## Mutations

### insert

Multiple insertions at one time :

```gql
mutation {
  insertFilm(input: {
    title: "Interstellar"
    language: {
    	name: "Spanish"
  	}
    originalLanguageId: 1
    filmCategories: [
      {
        categoryId: 14
      }
      {
        category: {
          name: "Adventure"
        }
      }
    ]
  }) {
    filmId
    filmCategories {
      category {
        categoryId
      }
    }
    language {
      languageId
    }
    original {
      languageId
    }
  }
}
```

Here we used an existing `Language` (english with id `1`) and associated it as the original language. For the movie language, we introduced a new "spanish" language. The same is true for categories : we use existing "Sci-fi" (id `14`) category and introduced a new "Adventure" `Category`.

The new ids are pulled in the response :

```json
{
  "data": {
    "insertFilm": {
      "filmId": 3,
      "filmCategories": [
        {
          "category": {
            "categoryId": 5
          }
        },
        {
          "category": {
            "categoryId": 6
          }
        }
      ],
      "language": {
        "languageId": 5
      },
      "original": {
        "languageId": 6
      }
    }
  }
}
```

Check :

```gql
query {
  films {
    title
    filmCategories(required: true) {
      category(query: { where: { name: "Adventure" } }, required: true) {
        categoryId
      }
    }
  }
}
```

Result :

```json
{
  "data": {
    "films": [
      {
        "title": "Interstellar",
        "filmCategories": [
          {
            "category": {
              "categoryId": 17
            }
          }
        ]
      }
    ]
  }
}
```
### update

```gql
mutation {
  updateFilm(query: { where: { filmId: 1001 } }, input: {
		releaseYear: 2014
  })
}
```

The resolver returns the amount of modified items :

```json
{
  "data": {
    "updateFilm": 1
  }
}
```

### delete

```gql
mutation {
  deleteFilmCategory(query: { where: { filmId: 1001 } })
}
```

The resolver returns the amount of deleted items :

```json
"data": {
  "deleteFilmCategory": 2
}
```

## Types

For each model, several types are created :

### Model type

This type is used for queries.

```gql
type Address {
  addressId: Int!
  address: String!
  address2: String
  district: String!
  postalCode: String
  phone: String!
  lastUpdate: Date!
  cityId: Int!
  customers(query: JSON, required: Boolean): [Customer]
  staffs(query: JSON, required: Boolean): [Staff]
  stores(query: JSON, required: Boolean): [Store]
  city(query: JSON, required: Boolean): City
}
```

### Insert input type

This type is used for insert mutations. Autoincremented fields becomes nullable, as for timestamp fields.

Note that in `Address` model, cityId cannot be `null`, but here it is nullable bexause you can either pass an existing `cityId` or a nested new `city` to be created at the same time. A `GraphQLUnionInput` should be pertinent here, but it is not yet implemented.

```gql
input AddressInsertInput {
  addressId: Int
  address: String!
  address2: String
  district: String!
  postalCode: String
  phone: String!
  lastUpdate: Date
  cityId: Int
  customers: [CustomerInsertInput]
  staffs: [StaffInsertInput]
  stores: [StoreInsertInput]
  city: CityInsertInput
}
```

### Update input type

Here, there is no more association and non nullable fields becomes nullable, so each field is optionnal (we lose the type information here : if we pass `null` to `cityId`, it will result in a constraint error). 

```gql
input AddressUpdateInput {
  addressId: Int
  address: String
  address2: String
  district: String
  postalCode: String
  phone: String
  lastUpdate: Date
  cityId: Int
}
```

## API

### `sequelizeToGraphQLSchemaBuilder`
```javascript
sequelizeToGraphQLSchemaBuilder(sequelize, { 
  namespace: '',
  extraModelFields: () => ({}),
  extraModelQueries: () => ({}),
  extraModelTypes: () => ({}),
  maxManyAssociations: 3,
  debug: false
})
```

#### `namespace`

A prefix for generated queries and types.

#### `extraModelFields({ modelsTypes, nameFormatter, logger }, model)`

A callback that lets you add custom fields to Sequelize models types.

To be documented...

#### `extraModelQueries({ modelsTypes, nameFormatter, logger }, model, queries)`

A callback that lets you add custom queries depending on generated Sequelize models types.

To be documented...

#### `extraModelTypes({ modelsTypes, nameFormatter, logger }, model)`

A callback that lets you add custom types depending on generated Sequelize models types.

To be documented...

### `maxManyAssociations`

Limits the number of "parallel" resulting left joins. Default is 3. 

#### `debug`

Prints debug infos. 

### `getRequestedAttributes(model, fieldNode, logger, map)`

To be documented...

### `beforeResolver(model, { nameFormatter, logger })`

To be documented...

### `findOptionsMerger(fo1, fo2)`

To be documented...

## Related project

 * [graphql-sequelize-r-react-admin](https://github.com/molaux/graphql-sequelize-r-react-admin) : a plugin that aims to provide API for [react-admin](https://github.com/marmelab/react-admin)
