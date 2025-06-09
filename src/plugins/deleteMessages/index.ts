/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Your Name/Alias and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import {
    ApplicationCommandOptionType,
    Argument,
    Command,
    CommandContext,
    registerCommand,
    unregisterCommand,
    sendBotMessage
} from "@api/Commands";
import definePlugin from "@utils/types";
import { Devs } from "@utils/constants"; // Assuming Devs can be used or add a placeholder
import { MessagesStore, Users } from "@webpack/common"; // Added Users for potential future use
// Removed getAPIBaseURL and getModule as they are not used directly yet
import { findByProps, findByStoreName } from "@webpack";

// Attempt to find the module containing fetchMessages
const FetchMessageActionsModule = findByProps("fetchMessages", "sendMessage") ?? findByProps("fetchMessages");

if (!FetchMessageActionsModule) {
    console.error("[DeleteMessages] Failed to find FetchMessageActionsModule with fetchMessages.");
}
const apiFetchMessages = FetchMessageActionsModule?.fetchMessages ?? (async (params: {channelId: string, limit?: number}) => {
    console.error("[DeleteMessages] CRITICAL: fetchMessages function not found. Message fetching will not work.", params);
    return Promise.resolve();
});

// Attempt to find modules for deleting messages
const DeleteMessageActionsModule = findByProps("deleteMessages", "clearMessages") ?? findByProps("deleteMessage"); // deleteMessages for bulk, deleteMessage for single often in same module

if (!DeleteMessageActionsModule) {
    console.error("[DeleteMessages] Failed to find DeleteMessageActionsModule with deleteMessages/deleteMessage.");
}
const apiDeleteMessages = DeleteMessageActionsModule?.deleteMessages;
const apiDeleteSingleMessage = DeleteMessageActionsModule?.deleteMessage;

if (!apiDeleteMessages) {
    console.warn("[DeleteMessages] Bulk message deletion function (deleteMessages) not found. Will attempt single deletion only.");
}
if (!apiDeleteSingleMessage) {
    console.warn("[DeleteMessages] Single message deletion function (deleteMessage) not found. Some messages may not be deletable.");
}

// Attempt to find Permission-related modules
const PermissionStore = findByStoreName("PermissionStore") ?? findByProps("can", "getGuildPermissions", "canEveryone");
const Permissions = findByProps("MANAGE_MESSAGES", "SEND_MESSAGES", "CREATE_INSTANT_INVITE");

if (!PermissionStore) {
    console.error("[DeleteMessages] PermissionStore not found. Cannot verify user permissions.");
}
if (!Permissions) {
    console.error("[DeleteMessages] Permissions constants not found. Cannot verify user permissions.");
}
if (!Permissions?.MANAGE_MESSAGES) { // Specifically check for MANAGE_MESSAGES
    console.error("[DeleteMessages] Permissions.MANAGE_MESSAGES constant not found. Cannot verify user permissions effectively.");
}


const deleteCommand: Command = {
    name: "delete",
    description: "Deletes a specified number of messages in the current channel. Deletes recent messages if no number is given.",
    options: [
        {
            name: "count",
            description: "Number of messages to delete.",
            type: ApplicationCommandOptionType.INTEGER,
            required: false,
        },
    ],
    execute: async (args: Argument[], ctx: CommandContext) => {
        const { channel } = ctx;

        // Permission Check
        if (PermissionStore && Permissions && Permissions.MANAGE_MESSAGES) {
            if (!PermissionStore.can(Permissions.MANAGE_MESSAGES, channel)) {
                try {
                    await sendBotMessage(channel.id, "You do not have permission to delete messages in this channel.");
                } catch (e) {
                    console.error("[DeleteMessages] Failed to send 'no permission' message:", e);
                }
                return;
            }
        } else {
            console.warn("[DeleteMessages] PermissionStore or Permissions constants (specifically MANAGE_MESSAGES) not found. Cannot check message deletion permissions. Proceeding with caution.");
            // Optionally, send a message to the user if desired, but for now, just log it.
            // try {
            //     await sendBotMessage(channel.id, "Warning: Could not verify permissions. Command may fail or be disallowed by Discord.");
            // } catch (e) {
            //     console.error("[DeleteMessages] Failed to send 'permission check unavailable' message:", e);
            // }
        }

        const countArg = args.find(arg => arg.name === "count");
        const count = countArg?.value as number | undefined; // Or parseInt(countArg.value) if it's a string

        console.log(`[DeleteMessages] Command executed in channel ${channel.id}. Count: ${count}`);

        if (!channel || !channel.id) {
            console.error("[DeleteMessages] Channel information is missing.");
            // Optionally send a message back to the user if possible, though context might be limited here
            // await sendBotMessage(ctx.channel.id, "Error: Could not identify the current channel.");
            return;
        }

        try {
            let messagesToDelete = [];
            const defaultFetchCount = 50; // Default number of messages to fetch if no count is provided

            if (count !== undefined && count > 0) {
                // Fetch 'count' messages
                // First, try to get from local store
                const currentChannelMessages = MessagesStore.getMessages(channel.id);
                messagesToDelete = currentChannelMessages.toArray().slice(-count).reverse(); // Get last 'count' and reverse to be newest first for some consistency, or oldest first depending on deletion strategy

                // If not enough messages are loaded or to ensure freshness, fetch them
                // This is a simplified fetch; actual API might need more params or handling
                if (messagesToDelete.length < count) {
                    // This is a placeholder for actual fetching logic for a specific count
                    // Real fetching might be more complex, involving fetching *around* a certain message ID or just fetching latest `count`
                    await apiFetchMessages({ channelId: channel.id, limit: count });
                    const updatedMessages = MessagesStore.getMessages(channel.id);
                    messagesToDelete = updatedMessages.toArray().slice(-count).reverse();
                }
                await sendBotMessage(channel.id, `Fetched ${messagesToDelete.length} message(s) to delete. (Count: ${count})`);
            } else {
                // Fetch default number of messages (e.g., last 50)
                await apiFetchMessages({ channelId: channel.id, limit: defaultFetchCount });
                const fetchedMessages = MessagesStore.getMessages(channel.id);
                messagesToDelete = fetchedMessages.toArray().slice(-defaultFetchCount).reverse();
                await sendBotMessage(channel.id, `Fetched last ${messagesToDelete.length} message(s) to delete.`);
            }

            const originalFetchedCount = messagesToDelete.length;
            // Filter out messages that are typically not user-deletable (e.g., system messages)
            // Standard user messages are type 0 (DEFAULT) and 19 (REPLY).
            messagesToDelete = messagesToDelete.filter(message => message.type === 0 || message.type === 19);

            const filteredCount = messagesToDelete.length;

            if (originalFetchedCount > 0 && filteredCount === 0) {
                await sendBotMessage(channel.id, "Found messages, but all were system messages or types that cannot be deleted by this command.");
                return;
            } else if (originalFetchedCount > filteredCount) {
                console.log(`[DeleteMessages] Filtered out ${originalFetchedCount - filteredCount} system/non-deletable messages.`);
            }

            if (messagesToDelete.length === 0) { // This covers both initially no messages, and all messages filtered out
                // The specific message for "all filtered out" is handled above.
                // This will catch "initially no messages found".
                if (originalFetchedCount === 0) { // Only send this if no messages were fetched to begin with
                    await sendBotMessage(channel.id, "No messages found to delete.");
                }
                return;
            }

            // console.log(`[DeleteMessages] Messages to delete (after filtering):`, messagesToDelete.map(m => ({id: m.id, content: m.content.substring(0,20), type: m.type })));

            console.log(`[DeleteMessages] Attempting to delete ${messagesToDelete.length} messages (after filtering).`);

            if (!apiDeleteMessages && !apiDeleteSingleMessage) {
                console.error("[DeleteMessages] CRITICAL: Message deletion functions not found.");
                await sendBotMessage(channel.id, "Error: Could not find message deletion functions. Plugin cannot operate.");
                return;
            }

            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

            let successfullyDeletedCount = 0;
            let failedToDeleteCount = 0;

            // Separate messages for bulk and single deletion
            const bulkDeleteCandidates = messagesToDelete.filter(m => new Date(m.timestamp).getTime() > twoWeeksAgo);
            const singleDeleteCandidatesInitially = messagesToDelete.filter(m => new Date(m.timestamp).getTime() <= twoWeeksAgo);

            let messagesAttemptedInBulk = [];

            if (apiDeleteMessages && bulkDeleteCandidates.length > 0) {
                messagesAttemptedInBulk = [...bulkDeleteCandidates];
                try {
                    console.log(`[DeleteMessages] Attempting bulk delete for ${bulkDeleteCandidates.length} messages.`);
                    await apiDeleteMessages(channel.id, bulkDeleteCandidates.map(m => m.id));
                    successfullyDeletedCount += bulkDeleteCandidates.length;
                    console.log(`[DeleteMessages] Bulk delete successful for ${bulkDeleteCandidates.length} messages.`);
                } catch (error) {
                    console.error("[DeleteMessages] Error during bulk delete:", error);
                    failedToDeleteCount += bulkDeleteCandidates.length; // Assume all failed initially
                    // Add them to single delete candidates if bulk failed
                    singleDeleteCandidatesInitially.push(...bulkDeleteCandidates); // Add all, then filter below
                    await sendBotMessage(channel.id, `Bulk delete failed. Error: ${error.message}. Will attempt single deletion for these if possible.`);
                }
            } else if (bulkDeleteCandidates.length > 0) {
                 console.warn("[DeleteMessages] apiDeleteMessages not found, cannot bulk delete messages. Adding to single delete queue.");
                 singleDeleteCandidatesInitially.push(...bulkDeleteCandidates);
            }

            // Determine messages for single deletion:
            // 1. Those initially too old.
            // 2. Those that were part of a failed bulk delete.
            // Ensure no duplicates and exclude any that might have been successfully bulk-deleted if logic was different.
            const finalSingleDeleteCandidates = Array.from(new Set(singleDeleteCandidatesInitially.map(m => m.id)))
                .map(id => singleDeleteCandidatesInitially.find(m => m.id === id))
                .filter(m => {
                    // If bulk delete was successful, none of messagesAttemptedInBulk should be here
                    // If bulk delete failed, all messagesAttemptedInBulk are candidates for single deletion
                    const wasInSuccessfulBulk = messagesAttemptedInBulk.some(bm => bm.id === m.id) && (successfullyDeletedCount === messagesAttemptedInBulk.length);
                    return !wasInSuccessfulBulk;
                });


            if (apiDeleteSingleMessage && finalSingleDeleteCandidates.length > 0) {
                console.log(`[DeleteMessages] Attempting single delete for ${finalSingleDeleteCandidates.length} messages.`);
                for (const message of finalSingleDeleteCandidates) {
                    try {
                        await apiDeleteSingleMessage(channel.id, message.id);
                        successfullyDeletedCount++; // Increment if was previously part of failed bulk
                        if (failedToDeleteCount > 0 && messagesAttemptedInBulk.some(bm => bm.id === message.id)) {
                            failedToDeleteCount--; // Correct count if now successfully deleted
                        }
                        // Optional: small delay to avoid rate limits
                        // await new Promise(resolve => setTimeout(resolve, 250));
                    } catch (error) {
                        console.error(`[DeleteMessages] Error deleting message ${message.id}:`, error);
                        if (!messagesAttemptedInBulk.some(bm => bm.id === message.id) || successfullyDeletedCount !== messagesAttemptedInBulk.length) {
                           // Only increment failed if it wasn't already counted as a bulk failure that wasn't resolved
                           // This logic gets tricky; simplify by ensuring failedToDeleteCount reflects actual final failures.
                           // The current failedToDeleteCount from bulk is an initial estimate.
                        }
                        // Let's refine failure counting post-loop
                    }
                }
            } else if (finalSingleDeleteCandidates.length > 0) {
                 console.warn("[DeleteMessages] apiDeleteSingleMessage not found, cannot delete older/failed messages individually.");
                 // failedToDeleteCount was already incremented for bulk failures.
                 // Add count for those that were ONLY single delete candidates.
                 const purelySingleCandidates = finalSingleDeleteCandidates.filter(m => !messagesAttemptedInBulk.some(bm => bm.id === m.id));
                 failedToDeleteCount += purelySingleCandidates.length;
            }

            // Recalculate failed count based on what wasn't successful
            // Use filteredCount for an accurate calculation of failed messages based on what was attempted
            failedToDeleteCount = filteredCount - successfullyDeletedCount;

            let feedbackMessage = "";
            if (successfullyDeletedCount > 0) {
                feedbackMessage += `Successfully deleted ${successfullyDeletedCount} message(s). `;
            }
            if (failedToDeleteCount > 0) {
                feedbackMessage += `Failed to delete ${failedToDeleteCount} message(s). `;
            }
            if (feedbackMessage === "" && filteredCount > 0 && successfullyDeletedCount === 0) {
                // All targeted messages failed
                feedbackMessage = `Failed to delete all ${failedToDeleteCount} targeted message(s). Check console for errors.`;
            } else if (feedbackMessage === "" && filteredCount === 0 && originalFetchedCount > 0) {
                // This specific case is handled by the "all were system messages" return, so this path shouldn't be hit.
                // If it is, it means logic prior needs review. For safety, provide a message.
                feedbackMessage = "No deletable messages were ultimately targeted after filtering.";
            } else if (feedbackMessage === "" && originalFetchedCount === 0) {
                // This case is handled by the "No messages found to delete" return.
                feedbackMessage = "No messages found to delete."; // Should have returned earlier
            } else if (feedbackMessage === "") {
                // Fallback for any unhandled state (e.g. filteredCount = 0, originalFetchedCount = 0 and somehow didn't return)
                feedbackMessage = "No action was taken. No messages were targeted or available for deletion.";
            }

            // Send feedback only if there's something to report or an explicit "no messages" state was determined.
            // The initial "No messages found to delete" or "all were system messages" handles cases where we return early.
            if (filteredCount > 0 || (originalFetchedCount > 0 && filteredCount == 0) ) { // Send if we attempted deletion OR if all were filtered out
               await sendBotMessage(channel.id, feedbackMessage.trim());
            } else if (originalFetchedCount === 0) {
                // If no messages were found initially, this is already handled by an early return.
                // If we reach here and originalFetchedCount is 0, it's an unexpected state, but avoid double message.
            }


        } catch (error) {
            console.error("[DeleteMessages] Error executing command:", error);
            await sendBotMessage(channel.id, "An error occurred while trying to delete messages. Check the console for details.");
        }
    },
};

export default definePlugin({
    name: "DeleteMessages",
    description: "Adds a /delete command to bulk delete messages.",
    authors: [Devs.YourNameOrAlias], // Replace YourNameOrAlias with a suitable alias or remove if not applicable
    start() {
        registerCommand(deleteCommand, "DeleteMessages"); // Ensure deleteCommand is in scope
        console.log("[DeleteMessages] Plugin started and /delete command registered.");
    },
    stop() {
        unregisterCommand(deleteCommand.name);
        console.log("[DeleteMessages] Plugin stopped and /delete command unregistered.");
    }
});
