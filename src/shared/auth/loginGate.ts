import type { AuthService } from "./authService";
import { AuthenticationError, type AuthSession, type AuthState } from "./types";

interface LoginGateOptions {
  authService: AuthService;
  onAuthenticated: (session: AuthSession) => void;
}

export function mountLoginGate(host: HTMLElement, options: LoginGateOptions): () => void {
  let renderedStatus: AuthState["status"] | null = null;
  const renderState = (state: AuthState): void => {
    if (renderedStatus === state.status) {
      return;
    }

    renderedStatus = state.status;
    if (state.status === "authenticated") {
      options.onAuthenticated(state.session);
    } else {
      renderLoginForm(host, options, renderState);
    }
  };

  const unsubscribe = options.authService.subscribe(renderState);
  const restored = options.authService.restore();
  renderState(restored
    ? { status: "authenticated", session: restored }
    : { status: "anonymous" });
  return unsubscribe;
}

function renderLoginForm(
  host: HTMLElement,
  options: LoginGateOptions,
  renderState: (state: AuthState) => void,
): void {

  const shell = document.createElement("main");
  shell.className = "login-shell";

  const card = document.createElement("section");
  card.className = "login-card";
  card.setAttribute("aria-labelledby", "login-title");

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "My Dashboard";

  const title = document.createElement("h1");
  title.id = "login-title";
  title.textContent = "登录私有数据仓库";

  const description = document.createElement("p");
  description.className = "login-description";
  description.textContent = "请输入 GitHub 用户名和拥有 Contents 读写权限的 token。";

  const form = document.createElement("form");
  form.className = "login-form";

  const username = createField("GitHub 用户名", "text", "username");
  username.input.autocomplete = "username";

  const token = createField("GitHub token", "password", "token");
  token.input.autocomplete = "current-password";

  const error = document.createElement("p");
  error.className = "login-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "登录";

  form.append(username.label, token.label, error, submit);
  card.append(eyebrow, title, description, form);
  shell.append(card);
  host.replaceChildren(shell);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "验证中…";

    void options.authService
      .login({ username: username.input.value, token: token.input.value })
      .then((session) => renderState({ status: "authenticated", session }))
      .catch((reason: unknown) => {
        error.textContent = reason instanceof AuthenticationError ? reason.message : "登录失败，请重试。";
        error.hidden = false;
      })
      .finally(() => {
        submit.disabled = false;
        submit.textContent = "登录";
      });
  });
}

function createField(text: string, type: "text" | "password", name: string): {
  label: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const label = document.createElement("label");
  label.className = "login-field";

  const caption = document.createElement("span");
  caption.textContent = text;

  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.required = true;
  input.spellcheck = false;

  label.append(caption, input);
  return { label, input };
}
