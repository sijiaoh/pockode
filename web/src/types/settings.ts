export type SandboxMode = "host" | "yolo_only" | "always";

export interface Settings {
	sandbox: SandboxMode;
}
