import { ApolloClient, HttpLink, InMemoryCache, split } from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";

const TOKEN_KEY = "teams-rebuild-token";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
};

export const wsClient = createClient({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/graphql`,
  connectionParams: () => ({ token: getToken() }),
  lazy: true,
  retryAttempts: Infinity,
  shouldRetry: () => true,
});

const http = setContext((_, { headers }) => {
  const token = getToken();
  return { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
}).concat(new HttpLink({ uri: "/graphql" }));

export const client = new ApolloClient({
  link: split(
    ({ query }) => {
      const d = getMainDefinition(query);
      return d.kind === "OperationDefinition" && d.operation === "subscription";
    },
    new GraphQLWsLink(wsClient),
    http,
  ),
  cache: new InMemoryCache({
    typePolicies: {
      User: { keyFields: ["mri"] },
      Query: {
        fields: {
          messages: {
            keyArgs: ["threadId"],
            merge(existing: any[] = [], incoming: any[], { args }) {
              return args?.before ? [...incoming, ...existing] : incoming;
            },
          },
        },
      },
    },
  }),
});

export const fileUrl = (url: string) => `${url}?token=${encodeURIComponent(getToken() ?? "")}`;
