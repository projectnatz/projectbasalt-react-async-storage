import React from "react"

const FORCE_REFRESH = Symbol("pn.basalt.store.force_refresh")

export namespace Store
{
	/** @version 1.0.0 */
	export type Args<Args extends any[]> = { [Key in keyof Args]: unknown | Args[Key] }

	/** @version 1.0.0 */
	export type Data<Value, DefaultValue, Deps extends any[]> =
		| Data.Loadable<Value, DefaultValue>
		| Data.Query<Value, DefaultValue, Deps>
		| Data.Settable<Value | DefaultValue>

	export namespace Data
	{
		/** @version 1.0.0 */
		interface Base
		{
			readonly name?: string
		}

		/** @version 1.0.0 */
		export interface Loadable<Value, DefaultValue> extends Base
		{
			defaultValue(): DefaultValue
			load(): Store.StoredValue<Value>
			readonly lifespan: Store.Lifespan
		}

		/** @version 1.0.0 */
		export interface Query<Value, DefaultValue, Deps extends any[]> extends Base
		{
			defaultValue(): DefaultValue
			check(args: unknown[]): args is Deps
			key(...deps: Deps): string
			load(...deps: Deps): Store.StoredValue<Value>
			readonly deps: Deps["length"]
			readonly lifespan: Store.Lifespan
		}

		/** @version 1.0.0 */
		export interface Settable<Value> extends Base
		{
			defaultValue(): Value
			readonly lifespan: 0
		}

		export const loadable = <Value, DefaultValue>(options: Store.Data.Loadable<Value, DefaultValue>) => options

		export const query = <Value, DefaultValue, Deps extends any[]>(options: Store.Data.Query<Value, DefaultValue, Deps>) => options

		export const settable = <Value>(options: Omit<Store.Data.Settable<Value>, "lifespan">): Store.Data.Settable<Value> =>
		({
			...options,
			lifespan: 0,
		})
	}

	/** @version 1.0.0 */
	export type Lifespan = number

	/** @version 1.0.0 */
	export type StoredValue<Value> = Value | Promise<Value>

	/** @version 1.0.0 */
	export interface Value<Value>
	{
		refresh(): void
		set(value: Store.StoredValue<Value>): void
		readonly data: Value
		readonly loading: boolean
	}
}

const EMPTY_ARRAY: never[] = []

export function createStore()
{
	const cache = new Map<string | Store.Data<unknown, unknown, unknown[]>, { expiresAt: Store.Lifespan, value: unknown, nextValue?: Promise<unknown> }>()
	const currents = new Map<Store.Data<unknown, unknown, unknown[]>, { deps: unknown[], key: string }>()
	const currentsListeners: typeof listeners = new Set()
	const listeners = new Set<(() => void)>()

	const notifyAll = () => (console.debug("Notifying all listeners..."), listeners.forEach(listener => listener()))
	const notifyAllCurrents = () => (console.debug("Notifying all currents listeners..."), currentsListeners.forEach(listener => listener()))

	const subscribe = (listener: () => void) => (listeners.add(listener), (() => { listeners.delete(listener) }))
	const subscribeToCurrent = (listener: () => void) => (currentsListeners.add(listener), (() => { currentsListeners.delete(listener) }))

	const loadData = <
		Value,
		DefaultValue = never,
		Deps extends any[] = [],
	>(data: Store.Data<Value, DefaultValue, Deps>, value?: Store.StoredValue<Value | DefaultValue> | typeof FORCE_REFRESH, ...args: Store.Args<Deps>) =>
	{
		const isQuery = "check" in data
			const deps = args as Deps

			if (isQuery && !data.check(args)) {
				return {
					data: data.defaultValue(),
					loading: false,
				}
			}

			const key = isQuery ? data.key(...deps) : data
			const chunk = cache.get(key)
			
			if (value !== undefined || chunk === undefined || isExpired(chunk.expiresAt)) {
				const expiresAt = expiration(data.lifespan)

				const previousValue = chunk !== undefined ? chunk.value : data.defaultValue()
				const nextValue
					= value !== undefined && value !== FORCE_REFRESH
						? value
					: "load" in data
						? data.load(...deps)
						: data.defaultValue()

				const nextChunk = nextValue instanceof Promise
					? { expiresAt, nextValue, value: previousValue }
					: { expiresAt, value: nextValue }

				cache.set(key, nextChunk)
				notifyAll()
					
				if (nextChunk.nextValue)
					nextChunk.nextValue.then(value => (cache.set(key, { expiresAt, value }), console.debug(`Updated value at "${key}".`), notifyAll()))
				
				return {
					data: nextChunk.value as Value | DefaultValue,
					loading: nextChunk.nextValue !== undefined,
				}
			}

			return {
				data: chunk.value as Value | DefaultValue,
				loading: chunk.nextValue !== undefined,
			}
	}

	const useCurrent = <
		Value,
		DefaultValue = never,
	>(data: Store.Data.Query<Value, DefaultValue, unknown[]>) =>
	{
		const deps = React.useSyncExternalStore(subscribeToCurrent, () => currents.get(data)?.deps ?? EMPTY_ARRAY)
		return useStore(data, ...deps)
	}

	const useCurrentDeps = <
		Value,
		DefaultValue = never,
		Deps extends any[] = [],
	>(data: Store.Data.Query<Value, DefaultValue, Deps>, ...deps: Store.Args<Deps>) =>
		React.useEffect(
			() =>
			{
				if (!data.check(deps)) {
					currents.delete(data)
					return
				}

				currents.set(data, { deps, key: data.key(...deps) })
				notifyAllCurrents()

				return () =>
				{
					currents.delete(data)
				}
			},
			[data, ...deps]
		)

	const useCurrentsDeps = <
		Datas extends CurrentDeps<any, any, any[]>[],
	>(datas: Datas, deps: React.DependencyList) =>
		React.useEffect(
			() =>
			{
				for (const [ data, ...deps ] of datas) {
					if (!data.check(deps)) currents.delete(data)
					else currents.set(data, { deps, key: data.key(...deps) })
				}

				notifyAllCurrents()
				return () => { datas.forEach(([data]) => currents.delete(data)) }
			},
			deps
		)

	const useRefresh = <Value, DefaultValue = never, Deps extends any[] = []>(data: Store.Data<Value, DefaultValue, Deps>, ...args: Store.Args<Deps>) =>
		useEvent(() => { loadData(data, FORCE_REFRESH, ...args) })

	const useSet = <Value, DefaultValue = never, Deps extends any[] = []>(data: Store.Data<Value, DefaultValue, Deps>, ...args: Store.Args<Deps>) =>
		useEvent((value: Store.StoredValue<Value | DefaultValue>) => { loadData(data, value, ...args) })

	const useStore = <
		Value,
		DefaultValue = never,
		Deps extends any[] = [],
	>(data: Store.Data<Value, DefaultValue, Deps>, ...args: Store.Args<Deps>): Store.Value<Value | DefaultValue> =>
	{
		const reload = (value?: Store.StoredValue<Value | DefaultValue> | typeof FORCE_REFRESH) => loadData(data, value, ...args)

		const previousState = React.useRef({ data: undefined as any, loading: false })
		const getState = () =>
		{
			const nextState = reload()
			return previousState.current.data === nextState.data && previousState.current.loading === nextState.loading
				? previousState.current as any as typeof nextState
				: nextState
		}

		const state = React.useSyncExternalStore(subscribe, getState)
		previousState.current = state
		
		const refresh = useEvent(() => { reload(FORCE_REFRESH) })
		const set = useEvent((value: Store.StoredValue<Value>) => { reload(value) })

		return React.useMemo(() => ({
			...state,
			refresh,
			set,
		}), [state])
	}

	return {
		useCurrent,
		useCurrentDeps,
		useCurrentsDeps,
		useRefresh,
		useSet,
		useStore,
		dumpAll: () => {
			const array1 = []
			const array2 = []
			for (const data of cache) array1.push(data)
			for (const data of currents) array2.push(data)
			return { cache: array1, currents: array2 }
		}
	}
}

function expiration(lifespan: Store.Lifespan): Store.Lifespan
{
	return lifespan === 0
		? 0
		: (new Date().valueOf() + lifespan)
}

function isExpired(expiresAt?: Store.Lifespan): boolean
{
	return expiresAt !== 0 && (expiresAt === undefined || expiresAt < new Date().valueOf())
}

type CurrentDeps<Value, DefaultValue, Deps extends any[]> = [ data: Store.Data.Query<Value, DefaultValue, Deps>, ...deps: Store.Args<Deps> ]