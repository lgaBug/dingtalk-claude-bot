export interface CardOptions {
  conversationId: string;
  title?: string;
  content: string;
}

export class CardMessage {
  static createCardPayload(options: CardOptions): object {
    return {
      msgType: 'interactive',
      card: {
        header: {
          title: {
            tag: 'plainText',
            content: options.title || 'Claude AI Assistant',
          },
          avatar: 'https://cdn-icons-png.flaticon.com/512/5693/5693025.png',
        },
        elements: [
          {
            tag: 'markdown',
            content: options.content,
          },
        ],
      },
    };
  }

  static createUpdatePayload(content: string): object {
    return {
      card: {
        elements: [
          {
            tag: 'markdown',
            content: content,
          },
        ],
      },
    };
  }
}
