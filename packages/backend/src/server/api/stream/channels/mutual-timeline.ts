/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Packed } from '@/misc/json-schema.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { bindThis } from '@/decorators.js';
import { isRenotePacked, isQuotePacked } from '@/misc/is-renote.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';

@Injectable({ scope: Scope.TRANSIENT })
export class MutualTimelineChannel extends Channel {
	public readonly chName = 'mutualTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';

	private withRenotes: boolean;
	private withFiles: boolean;
	private mutualIds = new Set<string>();

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
		private userFollowingService: UserFollowingService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		this.withRenotes = !!(params.withRenotes ?? true);
		this.withFiles = !!(params.withFiles ?? false);

		const mutualIds = await this.userFollowingService.getMutualFolloweeIds(this.user!.id);
		this.mutualIds = new Set(mutualIds);

		this.subscriber.on('notesStream', this.onNote);
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		const isMe = this.user!.id === note.userId;

		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;

		// 自分自身または相互フォロー相手以外は弾く
		if (!isMe && !this.mutualIds.has(note.userId)) return;

		if (!this.isNoteVisibleForMe(note)) return;

		if (note.reply) {
			const reply = note.reply;

			if (this.following[note.userId]?.withReplies) {
				// visibility: followers な投稿への返信のうち、自分が見えないものを除外
				if (reply.visibility === 'followers' && !Object.hasOwn(this.following, reply.userId) && reply.userId !== this.user!.id) {
					return;
				}
			} else {
				// 「自分宛ての返信」「自分がした返信」「自分自身への返信」以外は除外
				if (reply.userId !== this.user!.id && !isMe && reply.userId !== note.userId) return;
			}
		}

		// 純粋なリノート
		if (isRenotePacked(note) && !isQuotePacked(note) && note.renote) {
			if (!this.withRenotes) return;

			if (note.renote.reply) {
				const reply = note.renote.reply;
				if (reply.visibility === 'followers' && !Object.hasOwn(this.following, reply.userId) && reply.userId !== this.user!.id) {
					return;
				}
			}
		}

		if (this.isNoteMutedOrBlocked(note)) return;

		const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
		if (!filtered) return;

		if (isRenotePacked(note) && !isQuotePacked(note)) {
			if (note.renote && Object.keys(note.renote.reactions).length > 0) {
				const myRenoteReaction = await this.noteEntityService.populateMyReaction(note.renote, this.user!.id);
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