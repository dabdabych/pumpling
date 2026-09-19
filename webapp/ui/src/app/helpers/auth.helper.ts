import {JwtHelperService} from "@auth0/angular-jwt";

export class AuthHelper {
  constructor(){}

  public static hasCustomerRole(): boolean {
    let jwtHelper: JwtHelperService = new JwtHelperService();
    const token = localStorage.getItem("jwt");
    let tokenData = jwtHelper.decodeToken(token);
    return tokenData.role.indexOf('customer') !== -1;
  }

  public static hasAdminRole(): boolean {
    let jwtHelper: JwtHelperService = new JwtHelperService();
    const token = localStorage.getItem("jwt");
    let tokenData = jwtHelper.decodeToken(token);
    return tokenData.role.indexOf('admin') !== -1;
  }
}
