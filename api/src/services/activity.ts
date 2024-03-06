import { Action } from '@directus/constants';
import { useEnv } from '@directus/env';
import { ErrorCode, isDirectusError } from '@directus/errors';
import type { Accountability } from '@directus/types';
import { uniq } from 'lodash-es';
import { useLogger } from '../logger.js';
import type { AbstractServiceOptions, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import { getPermissions } from '../utils/get-permissions.js';
import { isValidUuid } from '../utils/is-valid-uuid.js';
import { Url } from '../utils/url.js';
import { userName } from '../utils/user-name.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';
import { NotificationsService } from './notifications.js';
import { UsersService } from './users.js';

const env = useEnv();
const logger = useLogger();

export class ActivityService extends ItemsService {
	notificationsService: NotificationsService;
	usersService: UsersService;

	constructor(options: AbstractServiceOptions) {
		super('directus_activity', options);
		this.notificationsService = new NotificationsService({ schema: this.schema });
		this.usersService = new UsersService({ schema: this.schema });
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		if (data['action'] === Action.COMMENT && typeof data['comment'] === 'string') {
			const usersRegExp = new RegExp(/@[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}/gi);

			const mentions = uniq(data['comment'].match(usersRegExp) ?? []);

			const sender = await this.usersService.readOne(this.accountability!.user!, {
				fields: ['id', 'first_name', 'last_name', 'email'],
			});

			for (const mention of mentions) {
				const userID = mention.substring(1);

				const user = await this.usersService.readOne(userID, {
					fields: ['id', 'first_name', 'last_name', 'email', 'role.id', 'role.admin_access', 'role.app_access'],
				});

				const accountability: Accountability = {
					user: userID,
					role: user['role']?.id ?? null,
					admin: user['role']?.admin_access ?? null,
					app: user['role']?.app_access ?? null,
				};

				accountability.permissions = await getPermissions(accountability, this.schema);

				const authorizationService = new AuthorizationService({ schema: this.schema, accountability });
				const usersService = new UsersService({ schema: this.schema, accountability });

				try {
					await authorizationService.checkAccess('read', data['collection'], data['item']);

					const templateData = await usersService.readByQuery({
						fields: ['id', 'first_name', 'last_name', 'email'],
						filter: { id: { _in: mentions.map((mention) => mention.substring(1)) } },
					});

					const userPreviews = templateData.reduce(
						(acc, user) => {
							acc[user['id']] = `<em>${userName(user)}</em>`;
							return acc;
						},
						{} as Record<string, string>,
					);

					let comment = data['comment'];

					for (const mention of mentions) {
						const uuid = mention.substring(1);
						// We only match on UUIDs in the first place. This is just an extra sanity check.
						if (isValidUuid(uuid) === false) continue;
						comment = comment.replace(new RegExp(mention, 'gm'), userPreviews[uuid] ?? '@Unknown User');
					}

					comment = `> ${comment.replace(/\n+/gm, '\n> ')}`;

					const href = new Url(env['PUBLIC_URL'] as string)
						.addPath('admin', 'content', data['collection'], data['item'])
						.toString();

					const message = `
Olá ${userName(user)},

${userName(sender)} mencionou você em um comentário:

${comment}

<a href="${href}">Clique aqui para ver.</a>
`;

					await this.notificationsService.createOne({
						recipient: userID,
						sender: sender['id'],
						subject: `Você foi mencionado em ${data['collection']}`,
						message,
						collection: data['collection'],
						item: data['item'],
					});
				} catch (err: any) {
					if (isDirectusError(err, ErrorCode.Forbidden)) {
						logger.warn(`User ${userID} doesn't have proper permissions to receive notification for this item.`);
					} else {
						throw err;
					}
				}
			}
		}

		return super.createOne(data, opts);
	}
}
