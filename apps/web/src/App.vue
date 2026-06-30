<script setup lang="ts">
import { onMounted } from "vue";
import AppHeader from "@/components/AppHeader.vue";
import ToastHost from "@/components/ToastHost.vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

onMounted(() => {
  auth.init();
});
</script>

<template>
  <AppHeader />
  <main class="app-main">
    <RouterView />
  </main>
  <ToastHost />
</template>

<style scoped>
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
</style>
