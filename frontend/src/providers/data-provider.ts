import { DataProvider } from "@refinedev/core";
import { AxiosInstance } from "axios";
import qs from "query-string";
import axios from "axios";

const axiosInstance = axios.create();

// Add Authorization header to all requests
axiosInstance.interceptors.request.use((config) => {
  const token = import.meta.env.VITE_SECONDARY_LAYER_KEY;
  
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  return config;
});

// Custom data provider with auth support
export const dataProvider = (
  apiUrl: string,
  httpClient: AxiosInstance = axiosInstance
): DataProvider => ({
  getList: async ({ resource, pagination, filters, sorters, meta }) => {
    const url = `${apiUrl}/${resource}`;

    const { current = 1, pageSize = 10, mode = "server" } = pagination ?? {};

    const query: {
      _start?: number;
      _end?: number;
      _sort?: string;
      _order?: string;
    } = {};

    if (mode === "server") {
      query._start = (current - 1) * pageSize;
      query._end = current * pageSize;
    }

    const generatedSort = sorters?.map((item) => ({
      field: item.field,
      order: item.order,
    }));

    if (generatedSort && generatedSort.length > 0) {
      query._sort = generatedSort[0].field;
      query._order = generatedSort[0].order;
    }

    const { data, headers } = await httpClient.get(
      `${url}?${qs.stringify(query)}`
    );

    const total = +headers["x-total-count"];

    return {
      data,
      total: total || data.length,
    };
  },

  getOne: async ({ resource, id, meta }) => {
    const url = `${apiUrl}/${resource}/${id}`;

    const { data } = await httpClient.get(url);

    return {
      data,
    };
  },

  create: async ({ resource, variables, meta }) => {
    const url = `${apiUrl}/${resource}`;

    const { data } = await httpClient.post(url, variables);

    return {
      data,
    };
  },

  update: async ({ resource, id, variables, meta }) => {
    const url = `${apiUrl}/${resource}/${id}`;

    const { data } = await httpClient.patch(url, variables);

    return {
      data,
    };
  },

  deleteOne: async ({ resource, id, meta }) => {
    const url = `${apiUrl}/${resource}/${id}`;

    const { data } = await httpClient.delete(url);

    return {
      data,
    };
  },

  getApiUrl: () => apiUrl,

  custom: async ({ url, method, filters, sorters, payload, query, headers }) => {
    let requestUrl = `${url}?`;

    if (sorters && sorters.length > 0) {
      const generatedSort = sorters.map((item) => ({
        field: item.field,
        order: item.order,
      }));
      const sortQuery = {
        _sort: generatedSort[0].field,
        _order: generatedSort[0].order,
      };
      requestUrl = `${requestUrl}&${qs.stringify(sortQuery)}`;
    }

    if (query) {
      requestUrl = `${requestUrl}&${qs.stringify(query)}`;
    }

    if (headers) {
      httpClient.defaults.headers = {
        ...httpClient.defaults.headers,
        ...headers,
      };
    }

    let axiosResponse;
    switch (method) {
      case "put":
      case "post":
      case "patch":
        axiosResponse = await httpClient[method](url, payload);
        break;
      case "delete":
        axiosResponse = await httpClient.delete(url, {
          data: payload,
        });
        break;
      default:
        axiosResponse = await httpClient.get(requestUrl);
        break;
    }

    const { data } = axiosResponse;

    return Promise.resolve({ data });
  },
});
