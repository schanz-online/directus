import { defineStore } from 'pinia';
import { Field } from '@directus/types';
import { useFieldsStore } from '@/stores/fields';
import { getEndpoint } from '@directus/utils';
import api from '@/api';
import { Mutex } from 'async-mutex';

class CollectionInfo {
	readonly defaultValues: Record<string, any> = {};
	readonly items: Map<number | string, Record<string, any>>;

	constructor(defaultValues: Record<string, any>) {
		this.defaultValues = defaultValues;
		this.items = new Map();
	}
}

class StackEntry {
	valid: boolean;
	useCount: number;
	readonly collectionKey: string;
	readonly primaryKey: number | string;
	readonly item: Record<string, any>;

	constructor(collectionKey: string, primaryKey: number | string, item: Record<string, any>) {
		this.valid = true;
		this.useCount = 1;
		this.collectionKey = collectionKey;
		this.primaryKey = primaryKey;
		this.item = item;
	}
}

export const shadowNone = {};

export const useShadowStore = defineStore('shadowStore', () => {
	const fieldsStore = useFieldsStore();
	const collectionInfos = new Map<string, CollectionInfo>();
	const stack: StackEntry[] = [];
	const pushMutex = new Mutex();

	async function push(
		collectionKey: string,
		primaryKey: number | string,
		modifiedValues: Record<string, any>,
	): Promise<object> {
		return await pushMutex.runExclusive(async () => {
			const prevEntry = stack[stack.length - 1];
			if (prevEntry != null && prevEntry.collectionKey === collectionKey && prevEntry.primaryKey === primaryKey) {
				++prevEntry.useCount;
				return prevEntry;
			}

			const item = await prepareItem(collectionKey, primaryKey, modifiedValues);

			const entry = new StackEntry(collectionKey, primaryKey, item);
			stack.push(entry);
			return entry;
		});
	}

	async function pop(shadowId: object) {
		await pushMutex.runExclusive(async () => {
			const entry = shadowId as StackEntry;

			const index = stack.lastIndexOf(entry);
			if (index === -1) {
				debugger;
			}

			if (entry.useCount > 1) {
				--entry.useCount;
			} else {
				for (let index2 = index + 1; index2 < stack.length; ++index2) {
					stack[index2]!.valid = false;
				}

				stack.splice(index, 1);

				if (stack.length === 0) {
					collectionInfos.clear();
				}
			}
		});
	}

	async function updateValue(shadowId: object, field: Field, value: any) {
		const entry = shadowId as StackEntry;

		if (!entry.valid || !stack.includes(entry)) {
			debugger;
		}

		let fixedValue = value;
		if (value === shadowNone) {
			const fieldKey = field.field;
			const collectionInfo = await getCollectionInfo(entry.collectionKey);

			fixedValue = collectionInfo.items.get(entry.primaryKey)?.[fieldKey] ?? collectionInfo.defaultValues[fieldKey];
		}

		await applyChange(entry.item, field, fixedValue, false);
	}

	function extendValidationPayload(values: Record<string, any>, field: Field): Record<string, any> {
		const collectionKey = field.collection;

		for (let index = stack.length - 1; index >= 0; --index) {
			const entry = stack[index]!;

			if (entry.collectionKey === collectionKey) {
				return entry.item;
			}
		}

		return values;
	}

	async function prepareItem(
		collectionKey: string,
		primaryKey: number | string,
		modifiedValues: Record<string, any>,
	): Promise<Record<string, any>> {
		const item = await getItem(collectionKey, primaryKey);

		for (const field of fieldsStore.getFieldsForCollection(collectionKey)) {
			const fieldKey = field.field;
			const value = item[fieldKey];
			const modifiedValue = modifiedValues[fieldKey];

			if (value !== undefined || modifiedValue !== undefined) {
				await applyChange(item, field, modifiedValue !== undefined ? modifiedValue : value, true);
			}
		}

		return item;
	}

	async function getCollectionInfo(collectionKey: string): Promise<CollectionInfo> {
		let collectionInfo = collectionInfos.get(collectionKey);
		if (collectionInfo == null) {
			const defaultValues: Record<string, any> = {};
			for (const field of fieldsStore.getFieldsForCollection(collectionKey)) {
				const defaultValue = field.schema?.default_value;

				if (defaultValue !== undefined && !(field.schema?.is_primary_key ?? false)) {
					defaultValues[field.field] = defaultValue;
				}
			}

			collectionInfo = new CollectionInfo(defaultValues);
			collectionInfos.set(collectionKey, collectionInfo);
		}

		return collectionInfo;
	}

	async function getItem(collectionKey: string, primaryKey: number | string): Promise<any> {
		const collectionInfo = await getCollectionInfo(collectionKey);

		let item: Record<string, any>;
		if (primaryKey === '+') {
			item = { ...collectionInfo.defaultValues };
		} else {
			const existingItem = collectionInfo.items.get(primaryKey);
			if (existingItem !== undefined) {
				item = { ...existingItem };
			} else {
				item = await fetchItem(collectionKey, primaryKey);
				collectionInfo.items.set(primaryKey, { ...item });
			}
		}

		return item;
	}

	async function applyChange(item: Record<string, any>, field: Field, value: any, initial: boolean): Promise<void> {
		const fieldKey = field.field;

		if (field.meta?.special?.includes('m2o')) {
			item[fieldKey] = await prepareM2OField(field, value, initial);
		} else if (!field.meta?.special?.includes('o2m')) {
			item[fieldKey] = value;
		}
	}

	async function prepareM2OField(field: Field, value: any, initial: boolean): Promise<Record<string, any> | null> {
		const collectionKey = field.schema!.foreign_key_table!;

		if (value === null) {
			const startIndex = stack.length - (initial ? 1 : 2);
			const endIndex = Math.max(0, startIndex - 1);

			for (let index = startIndex; index >= endIndex; --index) {
				const entry = stack[index]!;

				if (entry.collectionKey === collectionKey) {
					return { ...entry.item };
				}
			}

			return null;
		}

		const primaryKey = (typeof value === 'object' ? value.id : value) ?? '+';
		const item = await getItem(collectionKey, primaryKey);

		if (typeof value === 'object') {
			for (const field of fieldsStore.getFieldsForCollection(collectionKey)) {
				const fieldKey = field.field;
				const modification = value[fieldKey];

				if (modification !== undefined) {
					item[fieldKey] = modification;
				}
			}
		}

		return item;
	}

	async function fetchItem(collectionKey: string, primaryKey: number | string): Promise<Record<string, any>> {
		const endpoint = `${getEndpoint(collectionKey)}/${encodeURIComponent(primaryKey)}`;
		const response = await api.get(endpoint, {});
		return response.data.data as Record<string, any>;
	}

	return { push, pop, updateValue, extendValidationPayload };
});
