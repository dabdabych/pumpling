export interface IAppState {
  isAuthenticated: boolean;
}

export const initialAppState: IAppState = {
  isAuthenticated: !!localStorage.getItem("jwt")
};
