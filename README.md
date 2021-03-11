# Sequelize GraphQL Schema Builder

This project is an experimental work that aims to build a complete GraphQL schema for CRUD operations, on top of [graphql-sequelize](https://github.com/mickhansen/graphql-sequelize).

The `sequelizeGraphQLSchemaBuilder` builds queries, mutations, subscriptions and types needed to build a complete GraphQL API according to your Sequelize models and associations. Generated queries and mutations are able to resolve nested associations, so the GraphQL schema is tight to the Sequelize schema.

## Installation

``` bash
$ npm install --save @molaux/sequelize-graphql-schema-builder
```
`sequelize-graphql-schema-builder` assumes you have graphql and sequelize installed.

## Use

```javascript
const { schemaBuilder } = require('@molaux/sequelize-graphql-schema-builder')

const schema = sequelize => {
  const {
    modelsTypes: sequelizeModelsTypes,
    queries: sequelizeModelsQueries,
    mutations: sequelizeModelsMutations,
    subscriptions: sequelizeModelsSubscriptions
  } = schemaBuilder(sequelize)

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'RootQueryType',
      fields: () => sequelizeModelsTypes,
    }),
    subscription: new GraphQLObjectType({
      name: 'RootSubscriptionType',
      fields: () => sequelizeModelsSubscriptions
    }),
    mutation: new GraphQLObjectType({
      name: 'RootMutationType',
      fields: () => sequelizeModelsMutations
    })
  })
}
```

## Example

This documentation is based on the [Sequelize GraphQL Schema Builder example](https://github.com/molaux/sequelize-graphql-schema-builder-example).

## Queries

The query api will shape like this :

```gql
type RootQueryType {
  ...
  Staffs(query: JSON): [Staff]
  Stores(query: JSON): [Store]
  ...
}
```

```gql
query {
  Staffs {
    firstName
    fullName
    Store { 
      ManagerStaff {
      	firstName
      }
      Staffs {
        firstName
      }
    }
    ManagerStaffStores { 
      Staffs {
        fullName
      }
    }
    Address {
      address
    }
  }
}
```

```json
{
  "data": {
    "Staffs": [
      {
        "firstName": "Mike",
        "fullName": "Mike HILLYER",
        "Store": {
          "ManagerStaff": {
            "firstName": "Mike"
          },
          "Staffs": [
            {
              "firstName": "Mike"
            }
          ]
        },
        "ManagerStaffStores": [
          {
            "Staffs": [
              {
                "fullName": "Mike HILLYER"
              }
            ]
          }
        ],
        "Address": {
          "address": "23 Workhaven Lane"
        }
      },
      {
        "firstName": "Jon",
        "fullName": "Jon STEPHENS",
        "Store": {
          "ManagerStaff": {
            "firstName": "Jon"
          },
          "Staffs": [
            {
              "firstName": "Jon"
            }
          ]
        },
        "ManagerStaffStores": [
          {
            "Staffs": [
              {
                "fullName": "Jon STEPHENS"
              }
            ]
          }
        ],
        "Address": {
          "address": "1411 Lillydale Drive"
        }
      }
    ]
  }
}
```

Note the nested associations : here `Store` and `Staff` are linked by 2 foreign keys. 

[In the example](https://github.com/molaux/sequelize-graphql-schema-builder-example/tree/master/src/models/sakila/extensions/Staff.cjs), `Staff.firstName` has a getter that transforms raw data into upper case, and `Staff.fullName` is a `Sequelize` `VIRTUAL` field.

The corresponding SQL query is composed of multiple joins, and only needed fields to respond to the GraphQL query are pulled (and those needed by JOINs and VIRTUAL fields)

```sql
SELECT 
  "Staff"."first_name" AS "firstName",
  "Staff"."store_id" AS "storeId",
  "Staff"."staff_id" AS "staffId",
  "Staff"."address_id" AS "addressId",
  "Staff"."last_name" AS "lastName",
  "Store"."manager_staff_id" AS "Store.managerStaffId",
  "Store"."store_id" AS "Store.storeId",
  "Store->ManagerStaff"."staff_id" AS "Store.ManagerStaff.staffId",
  "Store->ManagerStaff"."first_name" AS "Store.ManagerStaff.firstName",
  "Store->Staffs"."staff_id" AS "Store.Staffs.staffId",
  "Store->Staffs"."first_name" AS "Store.Staffs.firstName",
  "ManagerStaffStores"."store_id" AS "ManagerStaffStores.storeId", "ManagerStaffStores->Staffs"."staff_id" AS "ManagerStaffStores.Staffs.staffId",
  "ManagerStaffStores->Staffs"."first_name" AS "ManagerStaffStores.Staffs.firstName",
  "ManagerStaffStores->Staffs"."last_name" AS "ManagerStaffStores.Staffs.lastName",
  "Address"."address_id" AS "Address.addressId", "Address"."address" AS "Address.address"
FROM "staff" AS "Staff"
LEFT OUTER JOIN "store" AS "Store" ON "Staff"."store_id" = "Store"."store_id"
LEFT OUTER JOIN "staff" AS "Store->ManagerStaff" ON "Store"."manager_staff_id" = "Store->ManagerStaff"."staff_id"
LEFT OUTER JOIN "staff" AS "Store->Staffs" ON "Store"."store_id" = "Store->Staffs"."store_id"
LEFT OUTER JOIN "store" AS "ManagerStaffStores" ON "Staff"."staff_id" = "ManagerStaffStores"."manager_staff_id"
LEFT OUTER JOIN "staff" AS "ManagerStaffStores->Staffs" ON "ManagerStaffStores"."store_id" = "ManagerStaffStores->Staffs"."store_id"
LEFT OUTER JOIN "address" AS "Address" ON "Staff"."address_id" = "Address"."address_id"
ORDER BY "Staff"."staff_id" ASC
```

### dissociate
The previous big join query can be splitted where you want with the optionnal argument `dissociate` (default is `false`) :

```gql
query {
  Staffs {
    firstName
    fullName
    Store(dissociate: true) { 
      ManagerStaff {
      	firstName
      }
      Staffs {
        firstName
      }
    }
    ManagerStaffStores { 
      Staffs {
        fullName
      }
    }
    Address {
      address
    }
  }
}
```

The resolvers will split association trees so the resulting queries will look like this :

```sql
SELECT 
  "Staff"."first_name" AS "firstName",
  "Staff"."staff_id" AS "staffId",
  ...
FROM "staff" AS "Staff"
LEFT OUTER JOIN "store" AS "ManagerStaffStores" ON "Staff"."staff_id" = "ManagerStaffStores"."manager_staff_id"
LEFT OUTER JOIN "staff" AS "ManagerStaffStores->Staffs" ON "ManagerStaffStores"."store_id" = "ManagerStaffStores->Staffs"."store_id"
LEFT OUTER JOIN "address" AS "Address" ON "Staff"."address_id" = "Address"."address_id"
ORDER BY "Staff"."staff_id" ASC;

SELECT 
  "Store"."manager_staff_id" AS "managerStaffId",
  "Store"."store_id" AS "storeId",
  "ManagerStaff"."staff_id" AS "ManagerStaff.staffId", "ManagerStaff"."first_name" AS "ManagerStaff.firstName", "Staffs"."staff_id" AS "Staffs.staffId", "Staffs"."first_name" AS "Staffs.firstName"
FROM "store" AS "Store"
LEFT OUTER JOIN "staff" AS "ManagerStaff" ON "Store"."manager_staff_id" = "ManagerStaff"."staff_id"
LEFT OUTER JOIN "staff" AS "Staffs" ON "Store"."store_id" = "Staffs"."store_id"
WHERE "Store"."store_id" = 1;

SELECT 
  "Store"."manager_staff_id" AS "managerStaffId",
  "Store"."store_id" AS "storeId",
  "ManagerStaff"."staff_id" AS "ManagerStaff.staffId", "ManagerStaff"."first_name" AS "ManagerStaff.firstName", "Staffs"."staff_id" AS "Staffs.staffId", "Staffs"."first_name" AS "Staffs.firstName"
FROM "store" AS "Store"
LEFT OUTER JOIN "staff" AS "ManagerStaff" ON "Store"."manager_staff_id" = "ManagerStaff"."staff_id"
LEFT OUTER JOIN "staff" AS "Staffs" ON "Store"."store_id" = "Staffs"."store_id"
WHERE "Store"."store_id" = 2;
```

The 2 `Staff` instances resulting from the first request resolve their `Store` seperatly.

For each model, a corresponding type is created :
```gql
type Film {
  filmId: ID!
  title: String!
  description: String
  releaseYear: Int
  rentalDuration: Int!
  rentalRate: String!
  length: Int
  replacementCost: String!
  rating: FilmratingEnumType
  specialFeatures: String
  lastUpdate: Date!
  languageId: ID!
  originalLanguageId: ID
  Inventories(query: JSON, dissociate: Boolean): [Inventory]
  Language(query: JSON, dissociate: Boolean): Language
  OriginalLanguage(query: JSON, dissociate: Boolean): Language
  Actors(query: JSON, dissociate: Boolean): [Actor]
  Categories(query: JSON, dissociate: Boolean): [Category]
}
```

### query

```gql
Films(query: JSON): [Film]
```

```gql
query {
  Films(query: { 
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
    Actors {
      lastName
    }
  }
}
```
Here, we juste want films for witch length is in [60, 70], and released in 2006 (there is no other release date in the database);

Operators should be formatted this way : `_${operator}Op` where `operator` is a key from `Sequelize.Op`.

```gql
query {
  Films(query: { 
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
    Actors(query: {
      required: true
      where: {
        lastName: "DEAN"
      }
    }) {
      firstName
      lastName
    }
  }
}
```

The same request as above, but this time we filtered movies having actors named "DEAN".

#### required

Lets say we haved nullized "Mike HILLYER" `store_id` in the database.

```gql
query {
  Staffs {
    fullName
    Store(query: { required: true }) {
      storeId
    }
  }
}
```
This time, "Mike HILLYER" is excluded, since he has no `Store`.

Note that this is not compatible with the `dissociate`: `true` argument on the same node since the required is passed to the `include` dependencies tree of the root requested element by Sequelize.

#### order, offset, limit

```gql
query {
  Films(query: { 
    where: {
      length: {
        _andOp: { 
          _gteOp: 60,
          _lteOp: 70,
        }
      },
      releaseYear: 2006
    }
    limit: 3
    offset: 0
    order: [[ "length", "DESC" ], [ "title", "DESC" ]]
  }) {
    length
    title
    releaseYear
    Inventories(query: {
      limit: 3
    	offset: 0
    }) { 
      inventoryId
    }
  }
}
```

The `limit` and `offset` options are supported in nested elements but be warned that the Sequelize `separate` flag is automatically setted in association. (See [Sequelize documentation](https://sequelize.org/master/class/lib/model.js~Model.html#static-method-findAll)).

Note that the `query` argument is more limited (by default) on nested nodes since its injected in association includes to the root `findAll` Sequelize query. To retrieve the behavior of root query (for example, for being able to use `order`) in nested nodes, you must `dissociate` the node.

#### group

To be documented

## Mutations

For input types, when possible, a fake `GraphQLUnionInputType` is used. It can be resolved either by a node embedding only its primary key (refering to an existing one), or any else that will be considered as a creation type :

```gql
input FilmCreateInput {
  filmId: ID
  title: String!
  description: String
  releaseYear: Int
  rentalDuration: Int
  rentalRate: String
  length: Int
  replacementCost: String
  rating: FilmratingEnumType
  specialFeatures: String
  lastUpdate: Date
  languageId: ID
  originalLanguageId: ID
  Inventories: [InputInventoryAssociationByInventoryId]
  Language: InputLanguageAssociationByLanguageId
  OriginalLanguage: InputLanguageAssociationByLanguageId
  Actors: [InputActorAssociationByActorId]
  Categories: [InputCategoryAssociationByCategoryId]
}

input InputFilmByFilmId {
  filmId: ID
}

scalar InputFilmAssociationByFilmId
```

`InputFilmAssociationByFilmId` can be a `FilmCreateInput` (an new film) or a `InputFilmByFilmId` (an existing film)

An `atomic` boolean parameter is available for all mutations to enable/disable the use of transactions (default is `true`). When transactions are enabled (by default), if something goes wrong, transaction for whole mutation is rolled back and pending publications for subscriptions are canceled.

### create

```gql
type RootMutationType {
  ...
  createFilm(input: FilmCreateInput, atomic: Boolean): Film
  ...
}
```

```gql
mutation {
  createFilm(input: {
    title: "Interstellar"
    # a new language
    Language: { 
    	name: "Breton" 
  	}
    # an existing language
    OriginalLanguage: { 
      languageId: 2
    }
    Categories: [
      # a new Category
      { 
        name: "New category"
      }
      # an existing Category
      {
        categoryId: 14
      }
      # a new Category
      { 
        name: "Other category"
        # we can create other nested creations / associations as well
      }
    ]
  }) {
    filmId
    Categories {
      categoryId
      name
    }
    Language {
      languageId
    }
    OriginalLanguage {
      languageId
    }
  }
}
```

The new ids are pulled in the response :

```json
{
  "data": {
    "createFilm": {
      "filmId": 1001,
      "Categories": [
        {
          "categoryId": "14",
          "name": "Sci-Fi"
        },
        {
          "categoryId": "149",
          "name": "New category"
        },
        {
          "categoryId": "150",
          "name": "Other category"
        }
      ],
      "Language": {
        "languageId": 10
      },
      "OriginalLanguage": {
        "languageId": 2
      }
    }
  }
}
```

### update

Update is a little bit different since we can omit any field to update only those needed, and wee need a query to select entities we want to apply mutation on.

Consequently non nullable fields have to become nullable.

```gql 
input FilmUpdateInput {
  filmId: ID
  title: String
  description: String
  releaseYear: Int
  rentalDuration: Int
  rentalRate: String
  length: Int
  replacementCost: String
  rating: FilmratingEnumType
  specialFeatures: String
  lastUpdate: Date
  languageId: ID
  originalLanguageId: ID
  Inventories: [InputInventoryAssociationByInventoryId]
  addInventories: [InputInventoryAssociationByInventoryId]
  Language: InputLanguageAssociationByLanguageId
  OriginalLanguage: InputLanguageAssociationByLanguageId
  Actors: [InputActorAssociationByActorId]
  addActors: [InputActorAssociationByActorId]
  removeActors: [InputActorByActorId]
  Categories: [InputCategoryAssociationByCategoryId]
  addCategories: [InputCategoryAssociationByCategoryId]
  removeCategories: [InputCategoryByCategoryId]
}

type RootMutationType {
  ...
  updateFilm(query: JSON, input: FilmUpdateInput, atomic: Boolean): [Film]
  ...
}
```

We can see that all associations are union types, so you can create new entities or refer to existing one.

The only exception is obviously for `belongsToMany` associations removal that can only refer to existing models (here: `removeCategories: [InputCategoryByCategoryId]`).

```gql
mutation {
  updateFilm(query: { where: { filmId: 1011 } }, input: {
    title: "Other title"
    Language: {
    	name: "Portuguese"
  	}
    OriginalLanguage: {
      languageId: 2
    }
    Categories: [
      {
        name: "New topic"
      }
      {
        name: "Other topic"
      }
      {
        categoryId: 10
      }
    ]
  }) {
    filmId
    Categories {
      categoryId
      name
    }
    Language {
      languageId
    }
    OriginalLanguage {
      languageId
    }
  }
}
```

### delete

```gql
type RootMutationType {
  ...
  deleteFilm(query: JSON, atomic: Boolean): [Film]
  ...
}
```

```gql
mutation {
  deleteFilm(query: { where: { filmId: 1001 } }) {
    filmId
  }
}
```

## Subscriptions

The builder creates three subscriptions for each model :

```gql
type RootSubscriptionType {
  ...
  createdCountry: [Country]
  updatedCountry: [Country]
  deletedCountry: [CountryID]
  ...
}

# Country ID type
type CountryID {
  countryId: ID
}
```

The `CountryID` type is the `Country` type, reduced to the only field we are sure to know after deletion : the primary key.

For subscriptions to work, you must [provide a `pubSub`](https://github.com/molaux/sequelize-graphql-schema-builder-example/blob/subscriptions/src/server.js) entry to the GraphQL context.

Warning : the cascading delete / set null is not handled yet, and will not trigger publications.

See the [`subscriptions` branch of the example](https://github.com/molaux/sequelize-graphql-schema-builder-example/tree/subscriptions) for testing purpose.

## API

### `schemaBuilder`
```javascript
schemaBuilder(sequelize, { 
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

A callback that lets you add custom fields to Sequelize models types. It will be called each time a GraphQL model type is built. The resulting object will be merged with model's GraphQL type fields.

[In this simple example (it's in the `extra-fields` branch)](https://github.com/molaux/sequelize-graphql-schema-builder-example/blob/extra-fields/src/schema/country/index.js), we use this hook to inject rich country infos coming from [restcountries.eu](https://restcountries.eu) to our `Country` GraphQL type. 

```gql
type Country {
  countryId: ID!
  country: String!
  lastUpdate: Date!
  infos: JSON
  Cities(query: JSON, dissociate: Boolean): [City]
}
```

In the example, we only return the field `infos` for `Country` model, but we can inject other common fields to all models if needed.

```gql
query {
  Countries(query: { limit: 3 }) {
    country
    infos
  }
}
```

```json
{
  "data": {
    "Countries": [
      {
        "country": "Afghanistan",
        "infos": [
          {
            "name": "Afghanistan",
            "topLevelDomain": [
              ".af"
            ],
            "alpha2Code": "AF",
            "alpha3Code": "AFG",
            "callingCodes": [
              "93"
            ],
            ...
          }
        ]
      },
      ...
    ]
  }
}
```

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

## Tests

The [Sequelize GraphQL Schema Builder example](https://github.com/molaux/sequelize-graphql-schema-builder-example) embeds a jest test suite.