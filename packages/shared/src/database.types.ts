// Generated from the migrations by `supabase gen types --lang typescript --local --schema public`
// against a local stack, then formatted with Prettier. Regenerate, never edit by hand.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string;
          created_at: string | null;
          id: string;
          metadata: Json | null;
          target_id: string | null;
          target_type: string | null;
          user_id: string | null;
        };
        Insert: {
          action: string;
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          target_id?: string | null;
          target_type?: string | null;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          created_at?: string | null;
          id?: string;
          metadata?: Json | null;
          target_id?: string | null;
          target_type?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      auditions: {
        Row: {
          audition_en_ligne: boolean;
          citycode: string | null;
          content: string;
          created_at: string | null;
          created_by: string | null;
          date: string;
          id: string;
          location: string;
          place: Json | null;
          status: Database["public"]["Enums"]["audition_status"] | null;
          title: string;
          updated_at: string | null;
        };
        Insert: {
          audition_en_ligne?: boolean;
          citycode?: string | null;
          content: string;
          created_at?: string | null;
          created_by?: string | null;
          date: string;
          id?: string;
          location: string;
          place?: Json | null;
          status?: Database["public"]["Enums"]["audition_status"] | null;
          title: string;
          updated_at?: string | null;
        };
        Update: {
          audition_en_ligne?: boolean;
          citycode?: string | null;
          content?: string;
          created_at?: string | null;
          created_by?: string | null;
          date?: string;
          id?: string;
          location?: string;
          place?: Json | null;
          status?: Database["public"]["Enums"]["audition_status"] | null;
          title?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      captured_emails: {
        Row: {
          body_html: string | null;
          body_text: string | null;
          created_at: string;
          id: string;
          recipients: string[];
          source: string;
          subject: string;
          user_id: string | null;
          viewer: string | null;
        };
        Insert: {
          body_html?: string | null;
          body_text?: string | null;
          created_at?: string;
          id?: string;
          recipients: string[];
          source: string;
          subject: string;
          user_id?: string | null;
          viewer?: string | null;
        };
        Update: {
          body_html?: string | null;
          body_text?: string | null;
          created_at?: string;
          id?: string;
          recipients?: string[];
          source?: string;
          subject?: string;
          user_id?: string | null;
          viewer?: string | null;
        };
        Relationships: [];
      };
      online_testimony_submissions: {
        Row: {
          created_at: string;
          email_hash: string;
          id: number;
          testimony_id: string | null;
        };
        Insert: {
          created_at?: string;
          email_hash: string;
          id?: never;
          testimony_id?: string | null;
        };
        Update: {
          created_at?: string;
          email_hash?: string;
          id?: never;
          testimony_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "online_testimony_submissions_testimony_id_fkey";
            columns: ["testimony_id"];
            isOneToOne: false;
            referencedRelation: "testimonies";
            referencedColumns: ["id"];
          },
        ];
      };
      testimonies: {
        Row: {
          audition_id: string | null;
          content: string;
          created_at: string | null;
          created_by: string | null;
          email: string | null;
          id: string;
          person_info: string | null;
          person_name: string;
          topics: string[] | null;
          verification_status: string | null;
          verification_token: string | null;
        };
        Insert: {
          audition_id?: string | null;
          content: string;
          created_at?: string | null;
          created_by?: string | null;
          email?: string | null;
          id?: string;
          person_info?: string | null;
          person_name: string;
          topics?: string[] | null;
          verification_status?: string | null;
          verification_token?: string | null;
        };
        Update: {
          audition_id?: string | null;
          content?: string;
          created_at?: string | null;
          created_by?: string | null;
          email?: string | null;
          id?: string;
          person_info?: string | null;
          person_name?: string;
          topics?: string[] | null;
          verification_status?: string | null;
          verification_token?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "testimonies_audition_id_fkey";
            columns: ["audition_id"];
            isOneToOne: false;
            referencedRelation: "auditions";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string | null;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      audition_testimony_counts: {
        Row: {
          audition_id: string | null;
          total_count: number | null;
          verified_count: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "testimonies_audition_id_fkey";
            columns: ["audition_id"];
            isOneToOne: false;
            referencedRelation: "auditions";
            referencedColumns: ["id"];
          },
        ];
      };
      distinct_testimony_topics: {
        Row: {
          topic: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      admin_testimonies: {
        Args: { p_audition_id?: string; p_id?: string };
        Returns: {
          audition_id: string;
          content: string;
          created_at: string;
          created_by: string;
          email: string;
          id: string;
          person_info: string;
          person_name: string;
          topics: string[];
          verification_status: string;
        }[];
      };
      get_audit_log: {
        Args: { p_limit?: number; p_offset?: number };
        Returns: {
          action: string;
          created_at: string;
          id: string;
          metadata: Json;
          target_id: string;
          target_type: string;
          user_email: string;
        }[];
      };
      get_pending_registrations: {
        Args: never;
        Returns: {
          bio: string;
          created_at: string;
          email: string;
          user_id: string;
          username: string;
        }[];
      };
      get_user_roles_with_details: {
        Args: never;
        Returns: {
          created_at: string;
          email: string;
          id: string;
          role: string;
          user_id: string;
          username: string;
        }[];
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      has_verified_testimony: { Args: { p_audition: string }; Returns: boolean };
      insert_audit_log: {
        Args: {
          p_action: string;
          p_metadata?: Json;
          p_target_id?: string;
          p_target_type?: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      is_admin: { Args: never; Returns: boolean };
      is_online_audition: { Args: { p_audition: string }; Returns: boolean };
      is_super_admin: { Args: never; Returns: boolean };
      online_testimony_ids: {
        Args: { p_unverified_only: boolean };
        Returns: string[];
      };
      reject_testimony_by_token: { Args: { p_token: string }; Returns: boolean };
      submit_online_testimony: {
        Args: {
          p_audition_content: string;
          p_citycode: string;
          p_content: string;
          p_email_hash: string;
          p_location: string;
          p_month: string;
          p_person_info: string;
          p_person_name: string;
          p_place: Json;
          p_title: string;
          p_token: string;
        };
        Returns: Json;
      };
      testimony_for_verification: {
        Args: { p_token: string };
        Returns: {
          audition_id: string;
          content: string;
          created_at: string;
          id: string;
          person_info: string;
          person_name: string;
          verification_status: string;
        }[];
      };
      verify_testimony: {
        Args: { p_action: string; p_token: string };
        Returns: boolean;
      };
      verify_testimony_by_token: {
        Args: { p_edits?: Json; p_token: string };
        Returns: boolean;
      };
    };
    Enums: {
      app_role: "admin" | "moderator" | "user" | "super_admin";
      audition_status: "published" | "draft";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user", "super_admin"],
      audition_status: ["published", "draft"],
    },
  },
} as const;
