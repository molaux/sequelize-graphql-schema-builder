# Graphql Sequelize R

This project is an experimental work that aims to bring relations and miscellaneous features on top of [graphql-sequelize](https://github.com/mickhansen/graphql-sequelize).
  
## Installation

$ npm install --save @molaux/graphql-sequelize-r

graphql-sequelize-r assumes you have graphql and sequelize installed.

## Use

```javascript
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

## Builder options

```javascript
sequelizeToGraphQLSchemaBuilder(sequelize, { 
  namespace: '',
  extraModelFields: () => ({}),
  extraModelQueries: () => ({}),
  extraModelTypes: () => ({}),
  debug: false
})
```

### `namespace`

A prefix for generated queries and types.

### `extraModelFields`

A callback that lets you add custom fields to Sequelize models types.

To be documented...

### `extraModelQueries`

A callback that lets you add custom queries depending on generated Sequelize models types.

To be documented...

### `extraModelTypes`

A callback that lets you add custom types depending on generated Sequelize models types.

To be documented...

### `debug`

Prints debug infos. 

## To do

Mutations

## Related project

 * [graphql-sequelize-r-react-admin](https://github.com/molaux/graphql-sequelize-r-react-admin) : a plugin that aims to provide API for [react-admin](https://github.com/marmelab/react-admin)
