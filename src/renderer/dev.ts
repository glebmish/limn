/** Single boundary for preload-provided development and screenshot automation. */
type DevConfig = NonNullable<Window['limnDev']>
export const dev: Partial<DevConfig> = typeof window === 'undefined' ? {} : window.limnDev ?? {}
