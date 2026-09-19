import { Injectable } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from './http-context-tokens';

export interface AllowTokenRequest {
  mint_address: string;
  lottery_type?: string;
}

export interface AllowTokenResponse {
  is_pumpfun_mint?: boolean;
  has_dex_liquidity?: boolean;
  dex_liquidity_pool_count?: number;
  dex_liquidity_check_unverified?: boolean;
  mint_address: string;
  network_type?: string;
  token_name?: string;
  token_symbol?: string;
  token_image_url?: string;
  /** The coin's market from DexScreener: any field may not arrive. */
  price_usd?: number;
  market_cap_usd?: number;
  liquidity_usd?: number;
  volume_24h_usd?: number;
  price_change_24h?: number;
  dex_id?: string;
  pair_url?: string;
  algorithm?: string;
  signer_pubkey?: string;
  lottery_address?: string;
  payer_address?: string;
  amount_lamports?: number;
  deadline_unix?: number;
  nonce_b64?: string;
  message_b64?: string;
  signature_b64?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AllowTokenService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient) {}

  async checkMint(request: AllowTokenRequest): Promise<AllowTokenResponse> {
    return firstValueFrom(
      this.http.post<AllowTokenResponse>(`${this.baseUrl}/lottery/check-mint`, request, {
        context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true),
      })
    );
  }
}
