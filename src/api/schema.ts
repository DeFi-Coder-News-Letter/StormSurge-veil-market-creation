import { gql, IResolvers } from "apollo-server";
import { GraphQLScalarType } from "graphql";
import uuid from "uuid/v4";
import { BigNumber } from "bignumber.js";
import { Market, Context } from "./types";
import { ethers } from "ethers";
import { differenceInMinutes } from "date-fns";

export const typeDefs = gql`
  scalar Date
  scalar JSON
  scalar BigNumber

  enum MarketStatus {
    draft
    activating
    active
  }

  enum MarketType {
    yesno
    scalar
    categorical
  }

  input Signature {
    message: String!
    signature: String!
    timestamp: Date!
  }

  type Market {
    uid: ID
    type: MarketType
    description: String!
    details: String
    resolutionSource: String
    endTime: Date
    tags: [String]
    category: String
    marketCreatorFeeRate: BigNumber
    author: String
    status: MarketStatus
    metadata: JSON
    numTicks: BigNumber
    minPrice: BigNumber
    maxPrice: BigNumber
    scalarDenomination: String
    openInterest: BigNumber
  }

  input MarketInput {
    type: MarketType
    description: String!
    details: String
    resolutionSource: String
    endTime: Date
    tags: [String]
    category: String
    marketCreatorFeeRate: BigNumber
    author: String
    signature: String
    metadata: JSON
    minPrice: BigNumber
    maxPrice: BigNumber
    numTicks: BigNumber
    scalarDenomination: String
  }

  type Query {
    markets(author: String!): [Market]
    market(uid: String!): Market
  }

  type Mutation {
    createMarket(market: MarketInput!, signature: Signature!): Market
    updateMarket(
      uid: String!
      market: MarketInput!
      signature: Signature!
    ): Market
    activateMarket(
      uid: String!
      transactionHash: String!
      signature: String!
    ): Market
  }
`;

interface Signature {
  message: string;
  signature: string;
  timestamp: Date;
}

function validateSignature(market: Market, signature: Signature) {
  // Check for validity of message
  if (
    signature.message.indexOf(market.description) < 0 ||
    signature.message.indexOf(signature.timestamp.toISOString()) < 0
  )
    throw new Error("Signature does not match market");
  // Check that timestamp is sufficiently recent (to prevent signature reuse)
  if (differenceInMinutes(new Date(), signature.timestamp) > 10)
    throw new Error("Signature is too old");
  // Check that the signer is correct
  const recoveredAddress = ethers.utils.recoverAddress(
    ethers.utils.hashMessage(signature.message),
    signature.signature
  );
  if (recoveredAddress.toLowerCase() !== market.author.toLowerCase())
    throw new Error("Invalid signature");
  return true;
}

export const resolvers: IResolvers<any, Context> = {
  Query: {
    markets: async (_: any, args: { author: string }, ctx: Context) => {
      return await ctx.pg("markets").where("author", args.author);
    },
    market: async (_: any, args: { uid: string }, ctx: Context) => {
      return await ctx
        .pg("markets")
        .where("uid", args.uid)
        .first();
    }
  },
  Mutation: {
    createMarket: async (_: any, args: any, ctx: Context) => {
      const { signature, market } = args;
      // TODO: validate input
      validateSignature(market, signature);
      const [inserted] = await ctx
        .pg("markets")
        .insert({
          ...market,
          tags: JSON.stringify(market.tags || []),
          status: "draft",
          uid: uuid()
        })
        .returning("*");
      return inserted;
    },
    updateMarket: async (_: any, args: any, ctx: Context) => {
      const { signature, market } = args;
      const uid = args.uid;
      const existing: Market = await ctx
        .pg("markets")
        .where("uid", uid)
        .first();
      validateSignature(existing, signature);
      if (!existing) throw new Error("Market not found");
      if (existing.status !== "draft")
        throw new Error("Cannot update market after activation");
      // TODO: validate input
      const [updated] = await ctx
        .pg("markets")
        .where("uid", uid)
        .update({
          ...market,
          tags: JSON.stringify(market.tags || []),
          updatedAt: new Date()
        })
        .returning("*");
      return updated;
    },
    activateMarket: async (_: any, args: any, ctx: Context) => {
      const { uid, transactionHash } = args;
      const existing: Market = await ctx
        .pg("markets")
        .where("uid", uid)
        .first();
      if (!existing) throw new Error("Market not found");
      if (existing.status !== "draft")
        throw new Error("Market is already activated");
      // TODO: validate input
      const [updated] = await ctx
        .pg("markets")
        .where("uid", uid)
        .update({
          status: "activating",
          transactionHash
        })
        .returning("*");
      return updated;
    }
  },
  Date: new GraphQLScalarType({
    name: "Date",
    serialize: (date: Date) => date.toISOString(),
    parseValue: (value: any) => {
      if (value instanceof Date) return value;
      if (
        value.match(
          "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(.[0-9]{3})?Z"
        )
      )
        return new Date(value);
      return undefined;
    },
    parseLiteral(ast) {
      if (ast.kind === "StringValue") {
        if (
          ast.value.match(
            "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(.[0-9]{3})?Z"
          )
        )
          return new Date(ast.value);
      }
      return undefined;
    }
  }),
  BigNumber: new GraphQLScalarType({
    name: "BigNumber",
    serialize: (bn: string) => new BigNumber(bn).toString(),
    parseValue: (value: string) => {
      if (value.match(/^[0-9]{0,78}(\.[0-9]{0,78})?$/)) return value;
      return undefined;
    },
    parseLiteral(ast) {
      if (
        ast.kind === "StringValue" &&
        ast.value.match(/^[0-9]{0,78}(\.[0-9]{0,78})?$/)
      )
        return ast.value;
      return undefined;
    }
  })
};