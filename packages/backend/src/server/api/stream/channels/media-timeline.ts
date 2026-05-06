/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Packed } from '@/misc/json-schema.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { bindThis } from '@/decorators.js';
import { isQuotePacked, isRenotePacked } from '@/misc/is-renote.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';

@Injectable({ scope: Scope.TRANSIENT })
export class MediaTimelineChannel extends Channel {
	public readonly chName = 'mediaTimeline';
	public static shouldShare = false as const;
	public static requireCredential = false as const;

	private withReplies: boolean;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		this.withReplies = !!(params.withReplies ?? false);

		this.subscriber.on('notesStream', this.onNote);
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		if (note.fileIds == null || note.fileIds.length === 0) return;

		if (note.user.host !== null) return;
		if (note.visibility !== 'public') return;
		if (note.channelId != null) return;
		if (note.user.requireSigninToViewContents && this.user == null) return;
		if (note.renote && note.renote.user.requireSigninToViewContents && this.user == null) return;
		if (note.reply && note.reply.user.requireSigninToViewContents && this.user == null) return;

		if (note.reply && this.user && !this.following[note.userId]?.withReplies && !this.withReplies) {
			const reply = note.reply;
			if (reply.userId !== this.user.id && note.userId !== this.user.id && reply.userId !== note.userId) return;
		}

		// メディアTLでは純リノートは流さない
		if (isRenotePacked(note) && !isQuotePacked(note)) return;

		if (this.isNoteMutedOrBlocked(note)) return;

		const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
		if (!filtered) return;

		if (this.user && isRenotePacked(note) && !isQuotePacked(note)) {
			if (note.renote && Object.keys(note.renote.reactions).length > 0) {
				const myRenoteReaction = await this.noteEntityService.populateMyReaction(note.renote, this.user.id);
				note.renote.myReaction = myRenoteReaction;
			}
		}

		this.send('note', note);
	}

	@bindThis
	public dispose() {
		this.subscriber.off('notesStream', this.onNote);
	}
}