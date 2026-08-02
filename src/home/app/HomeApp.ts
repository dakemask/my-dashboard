import {
  AuthenticationError,
  authenticateGitHubCredentials,
  type AuthSession,
} from "../../shared/auth";
import {
  createDashboardProfileStore,
  type DashboardProfileStore,
} from "../../shared/profiles";
import {
  AccountSetupError,
  bindFirstAccount,
  clearAccountProfile,
  clearLocalProfile,
  inspectFirstAccount,
  type FirstAccountDirection,
} from "../accountSetup";
import { dashboardModules } from "../modules";
import {
  AccountSettingsDialog,
  AccountSetupCancelledError,
  createHomePage,
  type AccountCredentialsInput,
  type AccountSetupUiHooks,
} from "../ui";

type Authenticate = typeof authenticateGitHubCredentials;
type InspectFirstAccount = typeof inspectFirstAccount;
type BindFirstAccount = typeof bindFirstAccount;
type ClearAccountProfile = typeof clearAccountProfile;
type ClearLocalProfile = typeof clearLocalProfile;

export interface HomeAppDependencies {
  readonly profileStore?: DashboardProfileStore;
  readonly authenticate?: Authenticate;
  readonly inspectFirstAccount?: InspectFirstAccount;
  readonly bindFirstAccount?: BindFirstAccount;
  readonly clearAccountProfile?: ClearAccountProfile;
  readonly clearLocalProfile?: ClearLocalProfile;
}

/** Coordinates the home shell and account workflow; child views own their DOM. */
export class HomeApp {
  private readonly document: Document;
  private readonly profileStore: DashboardProfileStore;
  private readonly authenticate: Authenticate;
  private readonly inspectFirstAccount: InspectFirstAccount;
  private readonly bindFirstAccount: BindFirstAccount;
  private readonly clearAccountProfile: ClearAccountProfile;
  private readonly clearLocalProfile: ClearLocalProfile;
  private settingsDialog: AccountSettingsDialog | null = null;

  constructor(
    private readonly root: HTMLElement,
    dependencies: HomeAppDependencies = {},
  ) {
    this.document = root.ownerDocument;
    this.profileStore = dependencies.profileStore ?? createDashboardProfileStore();
    this.authenticate = dependencies.authenticate ?? authenticateGitHubCredentials;
    this.inspectFirstAccount = dependencies.inspectFirstAccount ?? inspectFirstAccount;
    this.bindFirstAccount = dependencies.bindFirstAccount ?? bindFirstAccount;
    this.clearAccountProfile = dependencies.clearAccountProfile ?? clearAccountProfile;
    this.clearLocalProfile = dependencies.clearLocalProfile ?? clearLocalProfile;
  }

  start(): void {
    this.render();
  }

  private render(): HTMLButtonElement | null {
    this.root.replaceChildren(createHomePage({
      document: this.document,
      profile: this.profileStore.getState(),
      modules: dashboardModules,
      onOpenAccountSettings: (trigger) => this.openAccountSettings(trigger),
    }));
    return this.root.querySelector<HTMLButtonElement>(".settings-button");
  }

  private openAccountSettings(trigger: HTMLButtonElement): void {
    if (this.settingsDialog) {
      this.settingsDialog.focus();
      return;
    }
    this.settingsDialog = new AccountSettingsDialog({
      document: this.document,
      host: this.root,
      getProfileState: () => this.profileStore.getState(),
      selectAccount: (accountId) => this.profileStore.selectAccount(accountId),
      addAccount: (credentials, hooks) => this.addAccount(credentials, hooks),
      describeError: describeAccountSetupFailure,
      onProfileChanged: () => this.render(),
      onClosed: () => {
        this.settingsDialog = null;
      },
    });
    this.settingsDialog.open(trigger);
  }

  private async addAccount(
    credentials: AccountCredentialsInput,
    hooks: AccountSetupUiHooks,
  ): Promise<void> {
    hooks.setBusyStage("正在验证 GitHub 凭据…");
    const session = await this.authenticate(credentials);
    const state = this.profileStore.getState();
    const profileId = createGitHubProfileId(session);
    let firstAccountDirection: FirstAccountDirection | null = null;

    if (state.mode === "local") {
      hooks.setBusyStage("正在检查全部模块的本机与云端数据…");
      const inspection = await this.inspectFirstAccount(session);
      const direction = inspection.needsChoice
        ? await hooks.chooseFirstAccountDirection()
        : inspection.suggestedDirection;
      firstAccountDirection = direction;
      hooks.setBusyStage(direction === "local-wins"
        ? "正在把全部模块接入账户并更新云端…"
        : "正在把全部模块接入账户并读取云端…");
      await this.bindFirstAccount(session, profileId, direction);
    }

    hooks.setBusyStage("正在保存账户设置…");
    try {
      this.profileStore.addAccount(session, profileId);
    } catch {
      if (state.mode === "local") {
        await this.clearAccountProfile(profileId).catch(() => undefined);
      }
      throw new AccountRegistrationError(firstAccountDirection === "local-wins");
    }
    if (state.mode === "local") {
      hooks.setBusyStage("正在清理已接管的本地模式缓存…");
      await this.clearLocalProfile();
    }
  }
}

function createGitHubProfileId(session: AuthSession): string {
  return `github-${session.credentials.username.toLocaleLowerCase("en-US")}`;
}

export function describeAccountSetupFailure(error: unknown): string {
  if (error instanceof AuthenticationError) return error.message;
  if (error instanceof AccountSetupCancelledError) {
    return "已取消添加账户；token 已清除，本地模式仍然保留。";
  }
  if (error instanceof AccountRegistrationError) {
    return error.remoteMayBePartiallyUpdated
      ? "账户设置未能保存。云端可能已经更新了部分模块；这些更新不会自动回滚，"
        + "请保持“本地覆盖云端”方向重试。未注册账户的临时本机数据会被清理，"
        + "本地模式仍然保留。"
      : "账户设置未能保存。未注册账户的临时本机数据会被清理，"
        + "本地模式和已有账户仍然保留。";
  }
  if (error instanceof AccountSetupError) {
    if (error.remoteMayBePartiallyUpdated === true) {
      return `${error.message} 未注册账户的临时本机数据会被清理，本地模式仍然保留。`;
    }
    return `${error.message} 未注册账户的临时本机数据会被清理，本地模式仍然保留。`;
  }
  return "添加账户失败；token 已清除，本地模式和已有账户仍然保留。";
}

export class AccountRegistrationError extends Error {
  constructor(readonly remoteMayBePartiallyUpdated: boolean) {
    super("Dashboard account registration failed.");
    this.name = "AccountRegistrationError";
  }
}
