import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

export class ApiClientService {
  private readonly apiEndpoint: string;
  private readonly apiClient: AxiosInstance;

  private buildCookieString(cookies: Record<string, string | undefined>) {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  constructor(apiEndpoint: string) {
    this.apiEndpoint = apiEndpoint;

    this.apiClient = axios.create({
      baseURL: this.apiEndpoint,
    });
  }

  get<T>(url: string, config?: AxiosRequestConfig) {
    return this.apiClient.get<T>(url, config);
  }

  post<T, InputDataType = unknown>(url: string, data?: InputDataType, config?: AxiosRequestConfig) {
    return this.apiClient.post<T>(url, data, config);
  }

  put<T, InputDataType = unknown>(url: string, data?: InputDataType, config?: AxiosRequestConfig) {
    return this.apiClient.put<T>(url, data, config);
  }

  delete<T>(url: string, config?: AxiosRequestConfig) {
    return this.apiClient.delete<T>(url, config);
  }

  patch<T, InputDataType = unknown>(
    url: string,
    data?: InputDataType,
    config?: AxiosRequestConfig
  ) {
    return this.apiClient.patch<T>(url, data, config);
  }

  setHeader(header: string, value: string) {
    this.apiClient.defaults.headers.common[header] = value;
  }

  appendCookie(cookies: Record<string, string | undefined>) {
    const cookieString = this.buildCookieString(cookies);
    this.apiClient.defaults.headers.common['Cookie'] = cookieString;
  }
}
