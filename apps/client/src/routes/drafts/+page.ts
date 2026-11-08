import {mailboxLoad} from "$lib/mailbox-load.js";
export const load = mailboxLoad<Awaited<ReturnType<typeof import("$lib/server/mailbox/drafts.js").load>>>();
