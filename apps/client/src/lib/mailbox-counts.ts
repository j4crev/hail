import {writable} from 'svelte/store';
export const mailboxCounts = writable<{scope:string;counts:{subscriptions:number;connections:number}} | null>(null);
