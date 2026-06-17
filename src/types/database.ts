export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '13.0.5';
  };
  public: {
    Tables: {
      actresses: {
        Row: {
          age: number | null;
          created_at: string | null;
          id: string;
          name: string;
          poster_image: string | null;
          updated_at: string | null;
        };
        Insert: {
          age?: number | null;
          created_at?: string | null;
          id?: string;
          name: string;
          poster_image?: string | null;
          updated_at?: string | null;
        };
        Update: {
          age?: number | null;
          created_at?: string | null;
          id?: string;
          name?: string;
          poster_image?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      tags: {
        Row: {
          created_at: string | null;
          id: string;
          name: string;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          name: string;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          name?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      tiktok_accounts: {
        Row: {
          aadvid: string;
          cooldown_until: string | null;
          created_at: string | null;
          csrftoken: string | null;
          raw_string: string | null;
          id: string;
          last_upload_at: string | null;
          name: string;
          sid_guard_ads: string;
          status: Database['public']['Enums']['tiktok_account_status'] | null;
          updated_at: string | null;
          upload_count: number | null;
        };
        Insert: {
          aadvid: string;
          cooldown_until?: string | null;
          created_at?: string | null;
          csrftoken?: string | null;
          raw_string?: string | null;
          id?: string;
          last_upload_at?: string | null;
          name: string;
          sid_guard_ads: string;
          status?: Database['public']['Enums']['tiktok_account_status'] | null;
          updated_at?: string | null;
          upload_count?: number | null;
        };
        Update: {
          aadvid?: string;
          cooldown_until?: string | null;
          created_at?: string | null;
          csrftoken?: string | null;
          raw_string?: string | null;
          id?: string;
          last_upload_at?: string | null;
          name?: string;
          sid_guard_ads?: string;
          status?: Database['public']['Enums']['tiktok_account_status'] | null;
          updated_at?: string | null;
          upload_count?: number | null;
        };
        Relationships: [];
      };
      video_actresses: {
        Row: {
          actress_id: string;
          created_at: string | null;
          id: string;
          video_id: string;
        };
        Insert: {
          actress_id: string;
          created_at?: string | null;
          id?: string;
          video_id: string;
        };
        Update: {
          actress_id?: string;
          created_at?: string | null;
          id?: string;
          video_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'video_actresses_actress_id_fkey';
            columns: ['actress_id'];
            isOneToOne: false;
            referencedRelation: 'actresses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'video_actresses_video_id_fkey';
            columns: ['video_id'];
            isOneToOne: false;
            referencedRelation: 'videos';
            referencedColumns: ['id'];
          },
        ];
      };
      video_networks: {
        Row: {
          created_at: string;
          id: string;
          logo: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          logo?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          logo?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      video_processing_queue: {
        Row: {
          actresses: string | null;
          created_at: string | null;
          file_id: string | null;
          id: string;
          index: number;
          progress: number;
          release_date: string | null;
          status: Database['public']['Enums']['video_processing_status'];
          thumbnail_url: string | null;
          torrent_id: string | null;
          updated_at: string | null;
          video_description: string | null;
          video_name: string | null;
          video_network: string | null;
        };
        Insert: {
          actresses?: string | null;
          created_at?: string | null;
          file_id?: string | null;
          id?: string;
          index: number;
          progress?: number;
          release_date?: string | null;
          status?: Database['public']['Enums']['video_processing_status'];
          thumbnail_url?: string | null;
          torrent_id?: string | null;
          updated_at?: string | null;
          video_description?: string | null;
          video_name?: string | null;
          video_network?: string | null;
        };
        Update: {
          actresses?: string | null;
          created_at?: string | null;
          file_id?: string | null;
          id?: string;
          index?: number;
          progress?: number;
          release_date?: string | null;
          status?: Database['public']['Enums']['video_processing_status'];
          thumbnail_url?: string | null;
          torrent_id?: string | null;
          updated_at?: string | null;
          video_description?: string | null;
          video_name?: string | null;
          video_network?: string | null;
        };
        Relationships: [];
      };
      video_tags: {
        Row: {
          created_at: string | null;
          id: string;
          tag_id: string;
          video_id: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          tag_id: string;
          video_id: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          tag_id?: string;
          video_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'video_tags_tag_id_fkey';
            columns: ['tag_id'];
            isOneToOne: false;
            referencedRelation: 'tags';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'video_tags_video_id_fkey';
            columns: ['video_id'];
            isOneToOne: false;
            referencedRelation: 'videos';
            referencedColumns: ['id'];
          },
        ];
      };
      videos: {
        Row: {
          created_at: string | null;
          description: string | null;
          hls_playlist_url: string | null;
          id: string;
          release_date: string | null;
          status: Database['public']['Enums']['video_status'] | null;
          thumbnail_url: string | null;
          title: string;
          updated_at: string | null;
          video_network_id: string | null;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          hls_playlist_url?: string | null;
          id?: string;
          release_date?: string | null;
          status?: Database['public']['Enums']['video_status'] | null;
          thumbnail_url?: string | null;
          title: string;
          updated_at?: string | null;
          video_network_id?: string | null;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          hls_playlist_url?: string | null;
          id?: string;
          release_date?: string | null;
          status?: Database['public']['Enums']['video_status'] | null;
          thumbnail_url?: string | null;
          title?: string;
          updated_at?: string | null;
          video_network_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'videos_video_network_id_fkey';
            columns: ['video_network_id'];
            isOneToOne: false;
            referencedRelation: 'video_networks';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      calculate_upload_progress: {
        Args: { total_bytes: number; uploaded_bytes: number };
        Returns: number;
      };
      cleanup_expired_upload_sessions: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      update_upload_progress: {
        Args: { p_session_id: string; p_uploaded_bytes: number };
        Returns: {
          is_complete: boolean;
          upload_progress: number;
        }[];
      };
      update_video_caching_stats: {
        Args: { p_video_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      tiktok_account_status: 'active' | 'limited' | 'inactive';
      video_processing_status: 'queued' | 'processing' | 'processed' | 'failed';
      video_status: 'uploaded' | 'pending' | 'processing' | 'ready' | 'failed';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      tiktok_account_status: ['active', 'limited', 'inactive'],
      video_processing_status: ['queued', 'processing', 'processed', 'failed'],
      video_status: ['uploaded', 'pending', 'processing', 'ready', 'failed'],
    },
  },
} as const;
