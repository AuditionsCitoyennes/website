// Supabase-generated database types (ported from the previous app).
// Regenerate with `supabase gen types typescript` if the schema changes.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "13.0.5";
  };
  public: {
    Tables: {
      audit_log: {
        Row: {
          id: string;
          user_id: string | null;
          action: string;
          target_type: string | null;
          target_id: string | null;
          metadata: Json | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          action: string;
          target_type?: string | null;
          target_id?: string | null;
          metadata?: Json | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          action?: string;
          target_type?: string | null;
          target_id?: string | null;
          metadata?: Json | null;
          created_at?: string | null;
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
      online_testimony_submissions: {
        Row: {
          id: number;
          testimony_id: string | null;
          email_hash: string;
          created_at: string;
        };
        Insert: {
          id?: never;
          testimony_id?: string | null;
          email_hash: string;
          created_at?: string;
        };
        Update: {
          id?: never;
          testimony_id?: string | null;
          email_hash?: string;
          created_at?: string;
        };
        Relationships: [];
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
        Relationships: [];
      };
    };
    Functions: {
      admin_testimonies: {
        Args: { p_audition_id?: string | null; p_id?: string | null };
        Returns: {
          id: string;
          audition_id: string | null;
          person_name: string;
          person_info: string | null;
          content: string;
          topics: string[] | null;
          email: string | null;
          verification_status: string | null;
          created_by: string | null;
          created_at: string | null;
        }[];
      };
      get_audit_log: {
        Args: {
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          id: string;
          action: string;
          target_type: string | null;
          target_id: string | null;
          metadata: Json | null;
          created_at: string;
          user_email: string | null;
        }[];
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      insert_audit_log: {
        Args: {
          p_user_id: string;
          p_action: string;
          p_target_type?: string | null;
          p_target_id?: string | null;
          p_metadata?: Json;
        };
        Returns: undefined;
      };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      submit_online_testimony: {
        Args: {
          p_email_hash: string;
          p_person_name: string;
          p_person_info: string | null;
          p_content: string;
          p_citycode: string;
          p_location: string;
          p_place: Json;
          p_month: string;
          p_title: string;
          p_audition_content: string;
          p_token: string;
        };
        Returns: Json;
      };
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      reject_testimony_by_token: { Args: { p_token: string }; Returns: boolean };
      testimony_for_verification: {
        Args: { p_token: string };
        Returns: {
          id: string;
          person_name: string;
          person_info: string | null;
          content: string;
          verification_status: string | null;
          audition_id: string | null;
          created_at: string | null;
        }[];
      };
      verify_testimony: {
        Args: { p_action: string; p_token: string };
        Returns: boolean;
      };
      verify_testimony_by_token: {
        Args: { p_token: string; p_edits?: Json | null };
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

type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T];

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user", "super_admin"],
      audition_status: ["published", "draft"],
    },
  },
} as const;
