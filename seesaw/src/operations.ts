// Selections from Seesaw 10.146.0's bundled GraphQL operations. No introspection required.
export const OPERATIONS = {
  conversations: `query conversations($cursor: String, $searchText: String, $isHidden: Boolean) {
    conversationsSearch(input: {page: {first: 15, after: $cursor}, searchText: $searchText, isHidden: $isHidden}) {
      __typename
      ... on Error { errorCode debugMessage }
      ... on ConversationsSearchPayload {
        conversationsConnection {
          pageInfo { endCursor hasNextPage }
          edges { ... on ConversationRecipientEdge {
            conversation {
              id label messageCount isArchived isHidden isClosedToGroup lastUpdated
              readStatus { lastSeenMessageId unreadCount }
              messagesConnection(page: {first: 1}) {
                edges { message { id contentPreview createDate authorId } }
              }
            }
          } }
        }
      }
    }
  }`,
  messages: `query conversation($conversationId: ConversationID!, $cursor: String, $limit: Int = 20) {
    conversation(input: {conversationId: $conversationId}) {
      __typename
      ... on Error { errorCode debugMessage }
      ... on ConversationPayload {
        conversation {
          id label
          messagesConnection(page: {first: $limit, after: $cursor}) {
            pageInfo { startCursor endCursor hasNextPage hasPreviousPage }
            edges { message {
              id content contentPreview createDate lastUpdated authorId isRemoved markupType
              item { id text primaryType compositeImageUrl audioCaptionUrl videoUrl attachment { url sourceUrl } }
            } }
          }
        }
      }
    }
  }`,
  sendMessage: `mutation sendMessage($conversationId: ConversationID!, $content: String!, $tempId: String!) {
    sendMessage(input: {conversationId: $conversationId, content: $content, tempId: $tempId, markupType: PLAIN_TEXT}) {
      __typename
      ... on Error { errorCode debugMessage }
      ... on SendMessagePayload { messageId tempId }
    }
  }`,
} as const;
