# Sequelize GraphQL Schema Builder

This project is an experimental work that aims to build a complete GraphQL schema for CRUD operations, on top of [graphql-sequelize](https://github.com/mickhansen/graphql-sequelize).

The `sequelizeGraphQLSchemaBuilder` builds queries, mutations, subscriptions and types needed to build a complete GraphQL API according to your Sequelize models and associations. Generated queries, mutations and subscriptions are able to resolve nested associations, so the GraphQL schema is tight to the Sequelize schema.

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
  Inventories(query: JSON, dissociate: Boolean): [Inventory]
  Language(query: JSON, dissociate: Boolean): Language
  OriginalLanguage(query: JSON, dissociate: Boolean): Language
  Actors(query: JSON, dissociate: Boolean): [Actor]
  Categories(query: JSON, dissociate: Boolean): [Category]
  FilmText(query: JSON, dissociate: Boolean): FilmText
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

The group clause uses existing attributes to apply aggregation functions. Note that the node must be dissociated to be applied (`dissociate: true`).

```gql
query {
  Suppliers(query: { where: {id: 5}}) {
    id
    Products {
      id
      label
      CustomerOrders(query: {
        transform: {
          quantity: {
            fn: [
              "SUM",
              { col: [ "quantity" ]}
            ]
          },
          price: {
            fn: [
              "AVG",
              { col: [ "price" ]}
            ]
          },
          date: {
            fn: [
              "concat",
              {
                cast: [
                  {
                    fn: [
                      "DATEPART",
                      { literal: [ "year" ]},
                      { col: [ "date" ]}
                    ]
                  },
                  "varchar"
                ]
              },
              "/",
              {
                cast: [
                  {
                    fn: [
                      "DATEPART",
                      { literal: [ "week" ]},
                      { col: [ "date" ]}
                    ]
                  },
                  "varchar"
                ]
              }
            ]
          },
          year: {
            fn: [
              "DATEPART",
              { literal: [ "year" ]},
              { col: [ "date" ]}
            ]
          },
          week: {
            fn: [
              "DATEPART",
              { literal: [ "week" ]},
              { col: [ "date" ]}
            ]
          }
        },
        where: {
          date: {
            _gtOp: "2020-08-31T00:00:00.000Z"
          }
        },
        group: ["year", "week"],
        order: [["date", "ASC"]]
      }, dissociate: true) {
        quantity
        date
        price
      }
    }
  }
}
```

The `transform` object introduce the possibility to transform fields using [Sequelize static methods](https://sequelize.org/master/class/lib/sequelize.js~Sequelize.html). For grouping to work, you need a `transform` with an aggregation function for each requested attribute. New aliases (here `year` and `week`) cannot be requested as it's not part of the schema.

```json
{
  "data": {
    "Suppliers": [
      {
        "id": "5",
        "Products": [
          {
            "id": "3215",
            "label": "SALAD",
            "CustomerOrders": [
              {
                "quantity": "18.546",
                "date": "2020/50",
                "price": "2.5"
              },
              {
                "quantity": "20.846",
                "date": "2020/51",
                "price": "2.5"
              },
              {
                "quantity": "2.284",
                "date": "2020/52",
                "price": "2.5"
              }
            ]
          },
          {
            "id": "3219",
            "label": "APPLE",
            "CustomerOrders": [
              {
                "quantity": "2.184",
                "date": "2020/36",
                "price": "2.25"
              },
              {
                "quantity": "12.602",
                "date": "2020/39",
                "price": "4.1"
              },
              {
                "quantity": "2.61",
                "date": "2020/40",
                "price": "4.1"
              }
            ]
          },
          ...
        ]
      }
    ]
  }
}

```

## Mutations

For input types, when possible, a fake `union type` is used (For example, here : `InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms`). It can be resolved either by a node embedding only its primary key (`InputLanguageByLanguageId` : refering to an existing one), or any else that will be considered as a creation type (`LanguageCreateInputThroughFilms`). The `LanguageCreateInputThroughFilms` is the `LanguageCreateInput` without the `Films` field : when you add a `Language` through a `Film` entity, you cannot add other `Films` to this new `Language` (at the present time).

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
  Inventories: [InputInventoryByInventoryIdOrInventoryCreateInputThroughFilm]
  Language: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms!
  OriginalLanguage: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms
  Actors: [InputActorByActorIdOrActorCreateInputThroughFilms]
  Categories: [InputCategoryByCategoryIdOrCategoryCreateInputThroughFilms]
  FilmText: InputFilmTextByFilmIdOrFilmTextCreateInputThroughFilm
}

input InputFilmByFilmId {
  filmId: ID
}

scalar InputFilmByFilmIdOrFilmCreateInputThroughLanguage
...

input FilmCreateInputThroughLanguage {
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
  Inventories: [InputInventoryByInventoryIdOrInventoryCreateInputThroughFilm]
  OriginalLanguage: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms
  Actors: [InputActorByActorIdOrActorCreateInputThroughFilms]
  Categories: [InputCategoryByCategoryIdOrCategoryCreateInputThroughFilms]
  FilmText: InputFilmTextByFilmIdOrFilmTextCreateInputThroughFilm
}
...

```

GraphQL union input type is [under discussions](https://github.com/graphql/graphql-spec/pull/825) at the present time. Here it is simulated through a `SCALAR` type. It works well but the unioned types are not exposed in the schema. It can be tricky to debug when having type issues since GraphQL consider the SCALAR as final type. To workaround this problem, I use explicit naming (`InputInventoryByInventoryIdOrInventoryCreateInputThroughFilm`) and add _mock_ queries to expose hidden types :

```gql
mockFilm(
    InputInventoryByInventoryId: InputInventoryByInventoryId
    InputLanguageByLanguageId: InputLanguageByLanguageId
    InputActorByActorId: InputActorByActorId
    InputCategoryByCategoryId: InputCategoryByCategoryId
    InputFilmTextByFilmId: InputFilmTextByFilmId
    FilmCreateInputThroughInventories: FilmCreateInputThroughInventories
    FilmCreateInputThroughLanguage: FilmCreateInputThroughLanguage
    FilmCreateInputThroughOriginalLanguage: FilmCreateInputThroughOriginalLanguage
    FilmCreateInputThroughActors: FilmCreateInputThroughActors
    FilmCreateInputThroughCategories: FilmCreateInputThroughCategories
    FilmCreateInputThroughFilmText: FilmCreateInputThroughFilmText
  ): Film

input FilmCreateInputThroughInventories {
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
  Language: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms!
  OriginalLanguage: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms
  Actors: [InputActorByActorIdOrActorCreateInputThroughFilms]
  Categories: [InputCategoryByCategoryIdOrCategoryCreateInputThroughFilms]
  FilmText: InputFilmTextByFilmIdOrFilmTextCreateInputThroughFilm
}
...
```

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
    # new one to one
    FilmText: {
      title: "FilmText title"
      description: "FilmText description"
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
      "filmId": "1001",
      "Categories": [
        {
          "categoryId": "14",
          "name": "Sci-Fi"
        },
        {
          "categoryId": "17",
          "name": "New category"
        },
        {
          "categoryId": "18",
          "name": "Other category"
        }
      ],
      "Language": {
        "languageId": "7"
      },
      "OriginalLanguage": {
        "languageId": "2"
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
  Inventories: [InputInventoryByInventoryIdOrInventoryCreateInputThroughFilm]
  addInventories: [InputInventoryByInventoryIdOrInventoryCreateInputThroughFilm]
  Language: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms
  OriginalLanguage: InputLanguageByLanguageIdOrLanguageCreateInputThroughFilms
  Actors: [InputActorByActorIdOrActorCreateInputThroughFilms]
  addActors: [InputActorByActorIdOrActorCreateInputThroughFilms]
  removeActors: [InputActorByActorId]
  Categories: [InputCategoryByCategoryIdOrCategoryCreateInputThroughFilms]
  addCategories: [InputCategoryByCategoryIdOrCategoryCreateInputThroughFilms]
  removeCategories: [InputCategoryByCategoryId]
  FilmText: InputFilmTextByFilmIdOrFilmTextCreateInputThroughFilm
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
  updateFilm(query: { where: { filmId: 1001 } }, input: {
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

For subscriptions to work, you must [provide a `pubSub`](https://github.com/molaux/sequelize-graphql-schema-builder-example/blob/master/src/server.js) entry to the GraphQL context.

Warning : the cascading delete / set null is not handled yet, and will not trigger publications.

See the [the example](https://github.com/molaux/sequelize-graphql-schema-builder-example) for testing purpose. Subscritions are tested with jest. Example :

```gql
mutation {
  createFilm(input: {
    title: "initial title"
    # a new language
    Language: { 
    	name: "initial language"
      Films: [{
        title: "New Film"
      }]
  	}
    # new one to one
    FilmText: {
      title: "B"
      description: "autre"
    }
    # an existing language
    OriginalLanguage: { 
      languageId: 1
    }
    Categories: [
      # a new Category
      { 
        name: "initial new category"
      }
      # an existing Category
      {
        categoryId: 14
      }
      # a new Category
      { 
        name: "initial other category"
        # we can create other nested creations / associations as well
      }
    ]
  }, atomic: true) {
    filmId
    title
    FilmText {
      filmId
      title
    }
    Categories {
      categoryId
      name
    }
    Language {
      languageId
      name
    }
    OriginalLanguage {
      languageId
      name
    }
  }
}
```

The above mutation will trigger following publications to subscribtors :
```json
{
  "data": {
    "updatedCategory": [
      {
        "categoryId": "14",
        "name": "Sci-Fi",
        "Films": [
          {
            "filmId": "1001",
            "title": "initial title"
          },
          {
            "filmId": "985",
            "title": "WONDERLAND CHRISTMAS"
          },
          {
            "filmId": "972",
            "title": "WHISPERER GIANT"
          }
        ]
      }
    ]
  }
}
```

```json
{
  "data": {
    "createdCategory": [
      {
        "categoryId": "17",
        "name": "initial new category",
        "Films": [
          {
            "filmId": "1001",
            "title": "initial title"
          }
        ]
      },
      {
        "categoryId": "18",
        "name": "initial other category",
        "Films": [
          {
            "filmId": "1001",
            "title": "initial title"
          }
        ]
      }
    ]
  }
}
```

```json
{
  "data": {
    "createdFilm": [
      {
        "filmId": "1001",
        "title": "initial title",
        "Categories": [
          {
            "categoryId": "14",
            "name": "Sci-Fi"
          },
          {
            "categoryId": "17",
            "name": "initial new category"
          },
          {
            "categoryId": "18",
            "name": "initial other category"
          }
        ],
        "Language": {
          "languageId": "7",
          "name": "initial language"
        }
      }
    ]
  }
}
```

```json
{
  "data": {
    "createdFilmText": [
      {
        "filmId": "1001",
        "title": "B",
        "Film": {
          "filmId": "1001"
        }
      }
    ]
  }
}
```

```json
{
  "data": {
    "updatedLanguage": [
      {
        "languageId": "1",
        "name": "English",
        "Films": [
          {
            "filmId": "1000",
            "title": "ZORRO ARK"
          },
          {
            "filmId": "999",
            "title": "ZOOLANDER FICTION"
          },
          {
            "filmId": "998",
            "title": "ZHIVAGO CORE"
          }
        ],
        "OriginalLanguageFilms": [
          {
            "filmId": "1001",
            "title": "initial title"
          }
        ]
      }
    ]
  }
}
```

```json
{
  "data": {
    "createdLanguage": [
      {
        "languageId": "7",
        "name": "initial language",
        "Films": [
          {
            "title": "initial title"
          }
        ],
        "OriginalLanguageFilms": []
      }
    ]
  }
}
```

## Meta infos

The generated schema exposes an other type of queries that aims to provide information about how to validate data on the client side.

```gql
type FilmMeta {
  validators: FilmValidator
  defaultValues: FilmDefaultValue
}

type FilmValidator {
  filmId: JSON
  title: JSON
  description: JSON
  releaseYear: JSON
  rentalDuration: JSON
  rentalRate: JSON
  length: JSON
  replacementCost: JSON
  rating: JSON
  specialFeatures: JSON
  lastUpdate: JSON
  languageId: JSON
  originalLanguageId: JSON
}

type FilmDefaultValue {
  rentalDuration: Int!
  rentalRate: String!
  replacementCost: String!
  rating: FilmratingEnumType!
  lastUpdate: Date!
}
```

For each field of `validators`, the provided object is the corresponding Sequelize validator (Regex have to be quoted as strings to be compatible with `JSON`). `defaultValues` is only present if at least one field has default value.

## API

### `schemaBuilder`
```javascript
schemaBuilder(sequelize, { 
  namespace: '',
  extraModelFields: () => ({}),
  extraModelQueries: () => ({}),
  extraModelTypes: () => ({}),
  subscriptionsContextFilter: (emitterContext, context) => true
  maxManyAssociations: 3,
  debug: false
})
```

#### `namespace`

A prefix for generated queries and types.

#### `extraModelFields({ modelsTypes, nameFormatter, logger }, model)`

A callback that lets you add custom fields to Sequelize models types. It will be called each time a GraphQL model type is built. The resulting object will be merged with model's GraphQL type fields.

[In the example](https://github.com/molaux/sequelize-graphql-schema-builder-example/blob/master/src/schema/country/index.js), we use this hook to inject rich country infos coming from [restcountries.eu](https://restcountries.eu) to our `Country` GraphQL type. 

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

#### `subscriptionsContextFilter(emitterContext, context)`

A filter passed to subcriptions `subscribe` and `resolve` methods in order to filter events based on emitter and subscriber context.

Example to not resend events to initiator of mutation (given that te client provides a uuid header and server handles this to context) :

```javascript
 { 
   subscriptionsContextFilter: (emitterContext, context) => emitterContext.user.uuid !== context.user.uuid
 }
 ```
#### `maxManyAssociations`

Limits the number of "parallel" resulting left joins. Default is 3. 

#### `debug`

Prints debug infos. 

### `getRequestedAttributes(model, fieldNode, infos, logger, map)`

To be documented...

### `beforeResolver(model, { nameFormatter, logger })`

To be documented...

### `findOptionsMerger(fo1, fo2)`

To be documented...

## Tests

The [Sequelize GraphQL Schema Builder example](https://github.com/molaux/sequelize-graphql-schema-builder-example) embeds a jest test suite.

## Related projects

 * [MUI App Biolerplate](https://github.com/molaux/mui-app-boilerplate) is a complete client / server application that relies on this piece of code.
 * [MUI CRUDF](https://github.com/molaux/mui-crudf) is a Material-UI component able to handle this API to generate CRUD interfaces