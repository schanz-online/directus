import { isArray, isObject, mergeWith } from 'lodash';
import { toRaw } from 'vue';

export function mergeItemData(
	defaultValues: Record<string, any>,
	existingValues: Record<string, any>,
	edits: Record<string, any>,
) {
	return mergeWith({}, defaultValues, existingValues, edits, customizer);

	function customizer(objValue: unknown, srcValue: unknown): any {
		if (typeof srcValue !== 'undefined') {
			const rawSrcValue = toRaw(srcValue);
			if (isArray(objValue) && isObject(rawSrcValue)) {
				if (rawSrcValue.create?.length === 0 && rawSrcValue.update?.length === 0) {
					return [];
				}

				return rawSrcValue;
			}

			return srcValue;
		}

		return undefined;
	}
}
