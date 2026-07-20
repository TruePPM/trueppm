/**
 * CRUD hook for the project's custom field definitions — Project Settings →
 * Workflow page (#521). Per-task values are not persisted yet; this hook only
 * shapes the schema.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export type CustomFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'SINGLE_SELECT'
  | 'MULTI_SELECT'
  | 'USER'
  | 'BOOLEAN';

export interface CustomFieldOption {
  value: string;
  label: string;
  color?: string | null;
}

export interface ProjectCustomField {
  id: string;
  name: string;
  fieldType: CustomFieldType;
  required: boolean;
  options: CustomFieldOption[];
  order: number;
  /** Opt-in to rendering this field's value on the board card face (#2143/#2144). */
  showOnCard: boolean;
  serverVersion: number;
}

interface ApiCustomField {
  id: string;
  name: string;
  field_type: CustomFieldType;
  required: boolean;
  options: CustomFieldOption[];
  order: number;
  show_on_card: boolean;
  server_version: number;
}

function fromApi(row: ApiCustomField): ProjectCustomField {
  return {
    id: row.id,
    name: row.name,
    fieldType: row.field_type,
    required: row.required,
    options: row.options ?? [],
    order: row.order,
    // Tolerate a pre-#2143 API that omits the field (renders as opt-out).
    showOnCard: row.show_on_card ?? false,
    serverVersion: row.server_version,
  };
}

const FIELDS_KEY = (projectId: string) => ['project-custom-fields', projectId] as const;

export interface CreateCustomFieldPayload {
  name: string;
  fieldType: CustomFieldType;
  required?: boolean;
  options?: CustomFieldOption[];
  showOnCard?: boolean;
}

export interface UpdateCustomFieldPayload {
  name?: string;
  required?: boolean;
  options?: CustomFieldOption[];
  order?: number;
  showOnCard?: boolean;
}

export function useProjectCustomFields(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId);

  const query = useQuery({
    queryKey: FIELDS_KEY(projectId ?? ''),
    queryFn: async () => {
      const res = await apiClient.get<ApiCustomField[]>(`/projects/${projectId}/fields/`);
      return res.data.map(fromApi);
    },
    enabled,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: async (payload: CreateCustomFieldPayload) => {
      const res = await apiClient.post<ApiCustomField>(`/projects/${projectId}/fields/`, {
        name: payload.name,
        field_type: payload.fieldType,
        required: payload.required ?? false,
        options: payload.options ?? [],
        show_on_card: payload.showOnCard ?? false,
      });
      return fromApi(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FIELDS_KEY(projectId ?? '') });
    },
  });

  const update = useMutation({
    mutationFn: async (args: { id: string; payload: UpdateCustomFieldPayload }) => {
      const body: Record<string, unknown> = {};
      if (args.payload.name !== undefined) body.name = args.payload.name;
      if (args.payload.required !== undefined) body.required = args.payload.required;
      if (args.payload.options !== undefined) body.options = args.payload.options;
      if (args.payload.order !== undefined) body.order = args.payload.order;
      if (args.payload.showOnCard !== undefined) body.show_on_card = args.payload.showOnCard;
      const res = await apiClient.patch<ApiCustomField>(
        `/projects/${projectId}/fields/${args.id}/`,
        body,
      );
      return fromApi(res.data);
    },
    onSuccess: (row) => {
      queryClient.setQueryData<ProjectCustomField[] | undefined>(
        FIELDS_KEY(projectId ?? ''),
        (prev) => prev?.map((f) => (f.id === row.id ? row : f)).sort((a, b) => a.order - b.order),
      );
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/projects/${projectId}/fields/${id}/`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ProjectCustomField[] | undefined>(
        FIELDS_KEY(projectId ?? ''),
        (prev) => prev?.filter((f) => f.id !== id),
      );
    },
  });

  return {
    fields: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    create,
    update,
    remove,
  };
}
