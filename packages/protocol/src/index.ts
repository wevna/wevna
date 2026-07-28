// TODO: Define the real shape of a captured runtime event (source, kind,
// timestamp, payload, correlation ids) once the capture pipeline is designed.
// biome-ignore lint/suspicious/noEmptyInterface: placeholder until the shape is designed
export interface CapturedEvent {}

// TODO: Define what constitutes a session (a single run of the instrumented
// process) once session tracking is implemented.
// biome-ignore lint/suspicious/noEmptyInterface: placeholder until the shape is designed
export interface Session {}

// TODO: Define the wire envelope used to transport captured events from the
// SDK to the local server once the transport layer is implemented.
// biome-ignore lint/suspicious/noEmptyInterface: placeholder until the shape is designed
export interface Envelope {}
