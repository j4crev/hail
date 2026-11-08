import {messageListSummary, type MessageView} from '$lib/messages.js';
export function listSummary(message:MessageView) {
  const {blocks, paragraphs, attachments, ...metadata} = message;
  return {...metadata, ...messageListSummary({blocks, paragraphs})};
}
