import type { AuthService } from "../auth";
import type { DashboardProfileStore } from "../profiles";

interface RuntimeAuthenticationOptions {
  readonly authService: AuthService | null;
  readonly profileStore: DashboardProfileStore | null;
  readonly profileId: string | undefined;
  readonly pageWindow: Window;
  readonly onAuthenticationRequired?: () => void;
}

/** Owns the one-shot transition from an invalid account session back to the account boundary. */
export class RuntimeAuthentication {
  readonly #authService: AuthService | null;
  readonly #profileStore: DashboardProfileStore | null;
  readonly #profileId: string | undefined;
  readonly #pageWindow: Window;
  readonly #onAuthenticationRequired: (() => void) | undefined;
  #credentialsInvalidated = false;
  #authenticationNotificationSent = false;
  #authenticationTransitionStarted = false;
  #disposeRuntime: (() => Promise<void>) | null = null;

  constructor(options: RuntimeAuthenticationOptions) {
    this.#authService = options.authService;
    this.#profileStore = options.profileStore;
    this.#profileId = options.profileId;
    this.#pageWindow = options.pageWindow;
    this.#onAuthenticationRequired = options.onAuthenticationRequired;
  }

  attachRuntime(disposeRuntime: () => Promise<void>): void {
    this.#disposeRuntime = disposeRuntime;
    if (this.#credentialsInvalidated) {
      this.requireAuthentication();
    }
  }

  get credentialsInvalidated(): boolean {
    return this.#credentialsInvalidated;
  }

  invalidateCredentials(): void {
    if (!this.#credentialsInvalidated) {
      this.#credentialsInvalidated = true;
      if (this.#authService) {
        this.#authService.invalidate();
      } else if (this.#profileStore && this.#profileId) {
        this.#profileStore.removeAccount(this.#profileId);
      }
    }
    if (this.#disposeRuntime) {
      this.requireAuthentication();
    }
  }

  requireAuthentication(): void {
    if (this.#authenticationTransitionStarted) {
      return;
    }
    this.#authenticationTransitionStarted = true;
    const disposeRuntime = this.#disposeRuntime;
    if (!disposeRuntime) {
      this.notifyRequired();
      return;
    }
    void disposeRuntime().then(
      () => this.notifyRequired(),
      () => this.notifyRequired(),
    ).catch(() => undefined);
  }

  notifyRequired(): void {
    if (this.#authenticationNotificationSent) {
      return;
    }
    this.#authenticationNotificationSent = true;
    if (this.#onAuthenticationRequired) {
      this.#onAuthenticationRequired();
      return;
    }
    this.#pageWindow.location.replace(
      new URL(import.meta.env.BASE_URL, this.#pageWindow.location.href).href,
    );
  }
}
