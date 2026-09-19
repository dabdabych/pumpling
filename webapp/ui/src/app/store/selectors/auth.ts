import {createFeatureSelector, createSelector} from "@ngrx/store";
import {IAppState} from "../state/app.state";

export const featureSelector = createFeatureSelector<IAppState>('auth');

export const authSelector = createSelector(
  featureSelector,
  state => state.isAuthenticated
);
