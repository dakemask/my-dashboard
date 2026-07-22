import type {
  OperationGatePresentation,
  PersistenceOperationKind,
} from "../concurrency/OperationGate";

const ROOT_BUSY_ATTRIBUTE = "data-persistence-operation";
const CLOUD_ROOT_CLASS = "shared-cloud-operation-active";
const OVERLAY_CLASS = "shared-cloud-operation-overlay";
const SPINNER_CLASS = "shared-cloud-operation-spinner";

export interface DomOperationGatePresentationOptions {
  readonly document?: Document;
  readonly cloudStatusLabel?: string;
}

/** DOM presentation for the shared local/cloud blocking rules. */
export class DomOperationGatePresentation implements OperationGatePresentation {
  readonly #appRoot: HTMLElement;
  readonly #document: Document;
  readonly #cloudStatusLabel: string;
  #activeKind: PersistenceOperationKind | null = null;
  #rootWasInert = false;
  #overlay: HTMLElement | null = null;

  constructor(
    appRoot: HTMLElement,
    options: DomOperationGatePresentationOptions = {},
  ) {
    this.#appRoot = appRoot;
    this.#document = options.document ?? appRoot.ownerDocument;
    this.#cloudStatusLabel = options.cloudStatusLabel ?? "正在同步云端数据";
  }

  begin(kind: PersistenceOperationKind): void {
    if (this.#activeKind !== null) {
      throw new Error("An operation presentation is already active.");
    }

    this.#activeKind = kind;
    this.#rootWasInert = this.#appRoot.inert === true;
    this.#appRoot.inert = true;
    this.#appRoot.setAttribute(ROOT_BUSY_ATTRIBUTE, kind);

    if (kind === "cloud") {
      this.#appRoot.classList.add(CLOUD_ROOT_CLASS);
      this.#overlay = this.#createCloudOverlay();
      this.#document.body.append(this.#overlay);
    }
  }

  end(kind: PersistenceOperationKind): void {
    if (this.#activeKind !== kind) {
      return;
    }

    this.#overlay?.remove();
    this.#overlay = null;
    this.#appRoot.classList.remove(CLOUD_ROOT_CLASS);
    this.#appRoot.removeAttribute(ROOT_BUSY_ATTRIBUTE);
    this.#appRoot.inert = this.#rootWasInert;
    this.#activeKind = null;
  }

  #createCloudOverlay(): HTMLElement {
    const overlay = this.#document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-label", this.#cloudStatusLabel);
    overlay.dataset.operationGateOverlay = "cloud";

    const spinner = this.#document.createElement("span");
    spinner.className = SPINNER_CLASS;
    spinner.setAttribute("aria-hidden", "true");
    overlay.append(spinner);
    return overlay;
  }
}
