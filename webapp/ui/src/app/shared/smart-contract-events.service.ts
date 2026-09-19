import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface SmartContractEvent {
  id: number;
  signature?: string | null;
  event_name: string;
  data?: Record<string, unknown> | null;
  raw_logs?: string[] | null;
  created_at: string;
}

export interface PagedSmartContractEventResponse {
  items: SmartContractEvent[];
  total_count: number;
}

@Injectable({
  providedIn: 'root'
})
export class SmartContractEventsService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  getEvents(pageIndex = 0, pageSize = 10): Observable<PagedSmartContractEventResponse> {
    return this.http.get<PagedSmartContractEventResponse>(`${this.baseUrl}/smart-contract-events`, {
      params: { page_index: pageIndex, page_size: pageSize }
    });
  }
}
